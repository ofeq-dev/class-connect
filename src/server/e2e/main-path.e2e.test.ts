import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../course";
import { aClaimedStudent, aCourse, aRoster, aSession, listen, makeTestApp, openSse, signInLecturer, type TestApp } from "../testing";

/**
 * The demo's main path over SSE (docs/testing-strategy.md): the Lecturer and two Students each hold a
 * stream; the window opens, one Student checks in on the Classroom network and one off it, the
 * Lecturer approves the second network, opens a Poll, both vote, and it closes. Each stream gets the
 * right notices in the right order, and a refetch after each step shows the expected state.
 */

let t: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let courseId: number;
let session: Session;
let lecturer: string;
let dana: string;
let omar: string;

const CLASSROOM = "147.235.10.20";
const MOBILE = "2.54.1.1";

beforeEach(async () => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  aRoster(t, courseId, 3); // 1001 Dana Levi, 1002 Omar Haddad, 1003 Irina Petrova
  session = aSession(t, courseId);
  dana = `cc_device=${aClaimedStudent(t, courseId, "1001").deviceToken}`;
  omar = `cc_device=${aClaimedStudent(t, courseId, "1002").deviceToken}`;
  server = await listen(t);
  lecturer = await signInLecturer(server.url);
});
afterEach(async () => {
  t.timer.stop();
  await server.close();
  t.close();
});

const headers = (cookie: string, ip?: string): Record<string, string> => ({
  "content-type": "application/json",
  cookie,
  ...(ip ? { "cf-connecting-ip": ip } : {}),
});
const get = async <T = unknown>(path: string, cookie: string): Promise<T> => {
  const res = await fetch(`${server.url}${path}`, { headers: headers(cookie) });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};
const send = async <T = unknown>(method: string, path: string, body: unknown, cookie: string): Promise<T> => {
  const res = await fetch(`${server.url}${path}`, { method, headers: headers(cookie), body: JSON.stringify(body) });
  expect(res.status).toBeLessThan(300);
  return (await res.json()) as T;
};
/** Loading the QR page is the Check-in; CF-Connecting-IP puts the phone on or off the Classroom network. */
const scanFrom = async (cookie: string, ip: string) => {
  const res = await fetch(`${server.url}/api/student/s/${session.qrCode}`, { headers: headers(cookie, ip) });
  expect(res.status).toBe(200);
};

const sessionPath = (rest = "") => `/api/lecturer/courses/${courseId}/sessions/${session.id}${rest}`;
const coursePath = (rest = "") => `/api/lecturer/courses/${courseId}${rest}`;

type Glance = { present: number; pending: number; networks: { key: string }[] };
type Me = { checkIn: { status: string } };
type LecturerPoll = { id: number; status: string; votes: number; options: { id: number; label: string; votes: number }[] };
type StudentPolls = {
  open: { id: number; myVote: number | null; votes: number | null }[];
  closed: { id: number; myVote: number | null; votes: number | null; options: { votes: number | null }[] }[];
};

async function streams() {
  const open = async (path: string, cookie: string) => {
    const s = await openSse(`${server.url}${path}`, cookie);
    await s.next(); // ": connected"
    return s;
  };
  return {
    console: await open(`/api/lecturer/events?course=${courseId}`, lecturer),
    dana: await open("/api/student/events", dana),
    omar: await open("/api/student/events", omar),
  };
}

const quiet = (s: { nextMessage: (ms?: number) => Promise<unknown> }) =>
  expect(s.nextMessage(150)).rejects.toThrow(/timed out/);

describe("The demo's main path, across three streams", () => {
  it("delivers each step's notices in order to the right streams, and refetching shows the new state", async () => {
    const s = await streams();
    const attendance = { type: "attendance.changed", id: session.id };

    // 1. The Lecturer opens the Check-in window: everyone hears.
    await send("POST", sessionPath("/attendance/window/open"), { ipv4: CLASSROOM, ipv6: null }, lecturer);
    for (const stream of [s.console, s.dana, s.omar]) expect(await stream.nextMessage()).toEqual(attendance);
    expect((await get<Me>("/api/student/me", dana)).checkIn.status).toBe("open");

    // 2. Dana checks in on the Classroom network, Omar from mobile data: only the Lecturer hears.
    await scanFrom(dana, CLASSROOM);
    expect(await s.console.nextMessage()).toEqual(attendance);
    await scanFrom(omar, MOBILE);
    expect(await s.console.nextMessage()).toEqual(attendance);
    await quiet(s.dana);
    await quiet(s.omar);
    const pending = await get<Glance>(sessionPath("/attendance"), lecturer);
    expect(pending).toMatchObject({ present: 1, pending: 1 });
    expect((await get<Me>("/api/student/me", omar)).checkIn.status).toBe("pending");

    // 3. The Lecturer approves Omar's network: everyone hears, and Omar's Today turns checked in.
    await send("POST", sessionPath(`/attendance/networks/${pending.networks[0]!.key}/approve`), {}, lecturer);
    for (const stream of [s.console, s.dana, s.omar]) expect(await stream.nextMessage()).toEqual(attendance);
    expect(await get<Glance>(sessionPath("/attendance"), lecturer)).toMatchObject({ present: 2, pending: 0 });
    expect((await get<Me>("/api/student/me", omar)).checkIn.status).toBe("present");

    // 4. The Lecturer opens a Poll: everyone hears; the phones list it with no Vote yet.
    const topicId = (await get<{ id: number; kind: string }[]>(coursePath("/topics"), lecturer)).find(
      (x) => x.kind === "session",
    )!.id;
    const poll = await send<LecturerPoll>(
      "POST",
      coursePath("/polls"),
      { topicId, question: "How is the pace so far?", options: ["Too slow", "About right", "Too fast"], opensAt: "now" },
      lecturer,
    );
    const pollNotice = { type: "poll.changed", id: poll.id };
    for (const stream of [s.console, s.dana, s.omar]) expect(await stream.nextMessage()).toEqual(pollNotice);
    expect((await get<StudentPolls>("/api/student/polls", dana)).open).toMatchObject([
      { id: poll.id, myVote: null, votes: null },
    ]);

    // 5. Both vote: only the Lecturer hears; the console's totals move, with no names.
    const option = (label: string) => poll.options.find((o) => o.label === label)!.id;
    await send("POST", `/api/student/polls/${poll.id}/vote`, { optionId: option("Too fast") }, dana);
    expect(await s.console.nextMessage()).toEqual(pollNotice);
    await send("POST", `/api/student/polls/${poll.id}/vote`, { optionId: option("About right") }, omar);
    expect(await s.console.nextMessage()).toEqual(pollNotice);
    await quiet(s.dana);
    await quiet(s.omar);
    const live = await get<LecturerPoll[]>(sessionPath("/polls"), lecturer);
    expect(live).toMatchObject([{ id: poll.id, status: "open", votes: 2 }]);
    expect(live[0]!.options.map((o) => o.votes)).toEqual([0, 1, 1]);
    expect(JSON.stringify(live)).not.toMatch(/Dana|Omar/);
    // A Student still sees no totals while it's open.
    expect((await get<StudentPolls>("/api/student/polls", omar)).open[0]).toMatchObject({ myVote: option("About right"), votes: null });

    // 6. The Lecturer closes it: everyone hears, and the phones show the results.
    await send("POST", coursePath(`/polls/${poll.id}/close`), {}, lecturer);
    for (const stream of [s.console, s.dana, s.omar]) expect(await stream.nextMessage()).toEqual(pollNotice);
    const after = await get<StudentPolls>("/api/student/polls", dana);
    expect(after.open).toEqual([]);
    expect(after.closed[0]).toMatchObject({ id: poll.id, myVote: option("Too fast"), votes: 2 });
    expect(after.closed[0]!.options.map((o) => o.votes)).toEqual([0, 1, 1]);
    const refused = await fetch(`${server.url}/api/student/polls/${poll.id}/vote`, {
      method: "POST",
      headers: headers(omar),
      body: JSON.stringify({ optionId: option("Too slow") }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "vote.not-open" });

    for (const stream of [s.console, s.dana, s.omar]) {
      await quiet(stream);
      stream.close();
    }
  });
});

describe("A scheduled Poll", () => {
  it("opens and closes on every screen without a reload, on the next-event timer", async () => {
    t.timer.start();
    const s = await streams();
    const secret = (await get<{ secret: string }>(coursePath("/projector"), lecturer)).secret;
    const projector = await openSse(`${server.url}/api/projector/${secret}/events`, "");
    await projector.next();

    const topicId = (await get<{ id: number }[]>(coursePath("/topics"), lecturer))[0]!.id;
    const poll = await send<LecturerPoll>(
      "POST",
      coursePath("/polls"),
      { topicId, question: "Ready?", options: ["Yes", "No"], opensAt: "2026-11-30T08:05:00.000Z", closeAfterMinutes: 2 },
      lecturer,
    );
    const pollNotice = { type: "poll.changed", id: poll.id };
    // A scheduled Poll is the Lecturer's business until it opens.
    expect(await s.console.nextMessage()).toEqual(pollNotice);
    await quiet(s.dana);
    expect((await get<StudentPolls>("/api/student/polls", dana)).open).toEqual([]);

    t.fakes.clock.set("2026-11-30T08:05:00Z");
    t.fakes.timers.fireDue();
    for (const stream of [s.console, s.dana, s.omar, projector]) expect(await stream.nextMessage()).toEqual(pollNotice);
    expect((await get<StudentPolls>("/api/student/polls", dana)).open).toMatchObject([{ id: poll.id }]);

    t.fakes.clock.set("2026-11-30T08:07:00Z");
    t.fakes.timers.fireDue();
    for (const stream of [s.console, s.dana, s.omar, projector]) expect(await stream.nextMessage()).toEqual(pollNotice);
    expect((await get<StudentPolls>("/api/student/polls", omar)).closed).toMatchObject([{ id: poll.id, votes: 0 }]);

    for (const stream of [s.console, s.dana, s.omar, projector]) stream.close();
  });
});
