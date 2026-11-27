import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../course";
import { aClaimedStudent, aCourse, aRoster, aSession, listen, makeTestApp, openSse, signInLecturer, type TestApp } from "../testing";

let t: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let courseId: number;
let session: Session;
let lecturer: string;

const CLASSROOM = "147.235.10.20";

beforeEach(async () => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  aRoster(t, courseId, 3); // 1001 Dana Levi, 1002 Omar Haddad, 1003 Irina Petrova
  session = aSession(t, courseId);
  server = await listen(t);
  lecturer = await signInLecturer(server.url);
});
afterEach(async () => {
  await server.close();
  t.close();
});

const send = (method: string, path: string, body: unknown, cookie = "") =>
  fetch(`${server.url}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
const get = (path: string, cookie = "") => fetch(`${server.url}${path}`, { headers: { cookie } });

const scan = (cookie: string, ip?: string) =>
  fetch(`${server.url}/api/student/s/${session.qrCode}`, {
    headers: { cookie, ...(ip ? { "cf-connecting-ip": ip } : {}) },
  });
const claimed = (studentId: string) => `cc_device=${aClaimedStudent(t, courseId, studentId).deviceToken}`;

const coursePath = () => `/api/lecturer/courses/${courseId}`;
const sessionPath = () => `${coursePath()}/sessions/${session.id}`;
const setMode = (projectorMode: string) => send("PATCH", sessionPath(), { projectorMode }, lecturer);
const secret = async () => ((await (await get(`${coursePath()}/projector`, lecturer)).json()) as { secret: string }).secret;

describe("The Projector window link", () => {
  it("opens /p/<secret> with no sign-in, Blank until the Lecturer projects a Session", async () => {
    const res = await get(`/api/projector/${await secret()}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ courseName: "Software Engineering", mode: "blank", sessionId: null });
  });

  it("shows the QR code, the Session and the checked-in count once projected, and nothing else", async () => {
    expect((await setMode("qr")).status).toBe(200);
    await send("POST", `${sessionPath()}/attendance/window/open`, { ipv4: CLASSROOM, ipv6: null }, lecturer);
    await scan(""); // an unclaimed phone: not counted
    await scan(claimed("1001"), CLASSROOM); // Dana, Present
    await scan(claimed("1002"), "2.54.1.1"); // Omar, Pending: not counted

    const view = await (await get(`/api/projector/${await secret()}`)).json();
    expect(view).toEqual({
      courseName: "Software Engineering",
      mode: "qr",
      sessionId: session.id,
      session: { date: session.date, start: session.start, end: session.end, qrCode: session.qrCode },
      window: "open",
      checkedIn: 1,
    });
    expect(JSON.stringify(view)).not.toMatch(/Dana|Omar|1001|1002|pending/i);
  });

  it("goes Blank again when the Lecturer switches to Blank", async () => {
    await setMode("qr");
    await setMode("blank");
    expect(await (await get(`/api/projector/${await secret()}`)).json()).toMatchObject({ mode: "blank", sessionId: session.id });
  });

  it("refuses an old secret once the Lecturer makes a new link", async () => {
    const old = await secret();
    const res = await send("POST", `${coursePath()}/projector/new-link`, {}, lecturer);
    const { secret: fresh } = (await res.json()) as { secret: string };
    expect(fresh).not.toBe(old);
    expect((await get(`/api/projector/${old}`)).status).toBe(404);
    expect((await get(`/api/projector/${old}/events`)).status).toBe(404);
    expect((await get(`/api/projector/${fresh}`)).status).toBe(200);
    expect((await get(`/api/projector/nonsense`)).status).toBe(404);
  });

  it("keeps the link and the controls to the Lecturer", async () => {
    expect((await get(`${coursePath()}/projector`)).status).toBe(401);
    expect((await send("POST", `${coursePath()}/projector/new-link`, {})).status).toBe(401);
    expect((await send("PATCH", sessionPath(), { projectorMode: "qr" })).status).toBe(401);
    expect((await setMode("poll")).status).toBe(400);
  });

  it("shows a projected Poll: question, options and vote count while open; totals only once closed", async () => {
    const topicId = t.modules.feedback.listTopics(courseId)[0]!.id;
    const poll = (await (
      await send("POST", `${coursePath()}/polls`, { topicId, question: "Ready?", options: ["Yes", "No"], opensAt: "now" }, lecturer)
    ).json()) as { id: number; options: { id: number }[] };
    expect((await send("PATCH", sessionPath(), { projectorMode: "poll", projectedPollId: poll.id }, lecturer)).status).toBe(200);
    await send("POST", `/api/student/polls/${poll.id}/vote`, { optionId: poll.options[0]!.id }, claimed("1001"));

    const open = await (await get(`/api/projector/${await secret()}`)).json();
    expect(open).toEqual({
      courseName: "Software Engineering",
      mode: "poll",
      sessionId: session.id,
      poll: {
        id: poll.id,
        question: "Ready?",
        status: "open",
        votes: 1,
        options: [
          { id: poll.options[0]!.id, label: "Yes", votes: null },
          { id: poll.options[1]!.id, label: "No", votes: null },
        ],
      },
    });
    await send("POST", `${coursePath()}/polls/${poll.id}/close`, {}, lecturer);
    const closed = (await (await get(`/api/projector/${await secret()}`)).json()) as { poll: { options: { votes: number }[] } };
    expect(closed.poll.options.map((o) => o.votes)).toEqual([1, 0]);
    expect(JSON.stringify(closed)).not.toMatch(/Dana|1001/);
  });

  it("refuses to project another Course's Poll", async () => {
    const other = aCourse(t, "Algorithms").id;
    aSession(t, other);
    const theirs = t.modules.feedback.createPoll(other, {
      topicId: t.modules.feedback.listTopics(other)[0]!.id,
      question: "Q",
      options: ["a", "b"],
    });
    expect((await send("PATCH", sessionPath(), { projectorMode: "poll", projectedPollId: theirs.id }, lecturer)).status).toBe(404);
  });

  it("gives the console what the class sees, for its thumbnail", async () => {
    await setMode("qr");
    const body = await (await get(`${coursePath()}/projector`, lecturer)).json();
    expect(body).toMatchObject({ secret: await secret(), view: { mode: "qr", sessionId: session.id, checkedIn: 0 } });
  });
});

describe("The Projector window's stream", () => {
  it("receives only projector.changed and count notices", async () => {
    const projector = await openSse(`${server.url}/api/projector/${await secret()}/events`, "");
    expect(projector.status).toBe(200);
    await projector.next(); // ": connected"
    const dana = claimed("1001");
    const omar = claimed("1002");

    await send("POST", `${coursePath()}/roster`, { studentId: "1009", name: "Noa Cohen" }, lecturer);
    await setMode("qr");
    await send("POST", `${sessionPath()}/attendance/window/open`, { ipv4: CLASSROOM, ipv6: null }, lecturer);
    await scan(omar, "2.54.1.1"); // Pending
    await scan(dana, CLASSROOM); // Present
    await send("PATCH", sessionPath(), { end: "12:00" }, lecturer);
    await setMode("blank");

    const heard = [];
    for (let i = 0; i < 4; i++) heard.push(await projector.nextMessage());
    expect(heard).toEqual([
      { type: "projector.changed", id: courseId },
      { type: "attendance.changed", id: session.id },
      { type: "attendance.changed", id: session.id },
      { type: "projector.changed", id: courseId },
    ]);
    await expect(projector.nextMessage(300)).rejects.toThrow(/timed out/);
    projector.close();
  });
});
