import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../course";
import {
  aClaimedStudent,
  aCourse,
  aRoster,
  aSession,
  cookieHeader,
  listen,
  makeTestApp,
  openSse,
  signInLecturer,
  type TestApp,
} from "../testing";

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

const headers = (cookie: string, ip?: string): Record<string, string> => ({
  "content-type": "application/json",
  cookie,
  ...(ip ? { "cf-connecting-ip": ip } : {}),
});
const get = (path: string, cookie = "", ip?: string) => fetch(`${server.url}${path}`, { headers: headers(cookie, ip) });
const post = (path: string, body: unknown, cookie = "", ip?: string) =>
  fetch(`${server.url}${path}`, { method: "POST", headers: headers(cookie, ip), body: JSON.stringify(body) });

const attendancePath = () => `/api/lecturer/courses/${courseId}/sessions/${session.id}/attendance`;
const openWindow = (body: unknown = { ipv4: CLASSROOM, ipv6: null }) => post(`${attendancePath()}/window/open`, body, lecturer);
const claimed = (studentId: string) => `cc_device=${aClaimedStudent(t, courseId, studentId).deviceToken}`;
const scan = (cookie: string, ip?: string) => get(`/api/student/s/${session.qrCode}`, cookie, ip);

describe("The Check-in window, from the console", () => {
  it("opens with the Lecturer's addresses, counts against the Roster, and closes", async () => {
    expect((await openWindow({ ipv4: CLASSROOM, ipv6: "2a02:6680:1100:2a::1" })).status).toBe(200);
    const glance = await (await get(attendancePath(), lecturer)).json();
    expect(glance).toMatchObject({ window: { state: "open", lecturer: { ipv4: true, ipv6: true } }, present: 0, total: 3 });
    expect((await post(`${attendancePath()}/window/close`, {}, lecturer)).status).toBe(200);
    expect(await (await get(attendancePath(), lecturer)).json()).toMatchObject({ window: { state: "closed" } });
  });

  it("refuses a request without the Lecturer's cookie, and another Course's Session", async () => {
    expect((await post(`${attendancePath()}/window/open`, { ipv4: CLASSROOM })).status).toBe(401);
    const other = aSession(t, aCourse(t, "Algorithms").id);
    const res = await get(`/api/lecturer/courses/${courseId}/sessions/${other.id}/attendance`, lecturer);
    expect(res.status).toBe(404);
  });

  it("refuses an address of the wrong family", async () => {
    const res = await openWindow({ ipv4: "2a02::1", ipv6: null });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "check-in.bad-address" });
  });
});

describe("Check-in by QR code", () => {
  beforeEach(async () => {
    await openWindow();
  });

  it("checks a claimed phone in when it loads /s/<code>, with no further request", async () => {
    const res = await scan(claimed("1001"), "147.235.10.201");
    expect(await res.json()).toMatchObject({ me: { name: "Dana Levi" }, checkIn: { status: "present" } });
    const dana = t.modules.course.findRosterEntry(courseId, "1001")!;
    expect(t.modules.attendance.isPresent(session.id, dana.id)).toBe(true);
    expect(await (await get(attendancePath(), lecturer)).json()).toMatchObject({ present: 1, total: 3 });
  });

  it("reads CF-Connecting-IP to decide on- or off-network", async () => {
    expect(await (await scan(claimed("1001"), "147.235.10.99")).json()).toMatchObject({ checkIn: { status: "present" } });
    expect(await (await scan(claimed("1002"), "2.54.17.3")).json()).toMatchObject({ checkIn: { status: "pending" } });
    const log = t.modules.attendance.checkIns(session.id);
    expect(log.map((r) => r.ip)).toEqual(["147.235.10.99", "2.54.17.3"]);
  });

  it("claims an unclaimed phone and then checks it in, in one flow", async () => {
    const first = await scan("", CLASSROOM);
    expect(await first.json()).toMatchObject({ me: null, checkIn: null });
    const res = await post(`/api/student/s/${session.qrCode}/claim`, { studentId: "1001" }, "", "147.235.10.50");
    expect(await res.json()).toMatchObject({ name: "Dana Levi", checkIn: { status: "present" } });
    const cookie = cookieHeader(res);
    expect(await (await get("/api/student/me", cookie)).json()).toMatchObject({
      session: { id: session.id },
      checkIn: { status: "present" },
    });
  });

  it("tells a phone scanning while the window is closed to ask the Lecturer", async () => {
    await post(`${attendancePath()}/window/close`, {}, lecturer);
    const res = await scan(claimed("1001"), CLASSROOM);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ me: { name: "Dana Levi" }, checkIn: { status: "closed" } });
  });
});

describe("Live count", () => {
  it("sends each Check-in to the Lecturer's stream only; Students hear only of the window", async () => {
    const dana = claimed("1001");
    const omar = claimed("1002");
    const console = await openSse(`${server.url}/api/lecturer/events?course=${courseId}`, lecturer);
    const phone = await openSse(`${server.url}/api/student/events`, omar);
    await console.next();
    await phone.next(); // ": connected"
    const notice = { type: "attendance.changed", id: session.id };

    await openWindow();
    expect(await console.nextMessage()).toEqual(notice);
    expect(await phone.nextMessage()).toEqual(notice);

    await scan(dana, CLASSROOM);
    expect(await console.nextMessage()).toEqual(notice);
    expect(await (await get(attendancePath(), lecturer)).json()).toMatchObject({ present: 1 });

    await post(`${attendancePath()}/window/close`, {}, lecturer);
    expect(await console.nextMessage()).toEqual(notice);
    // The phone's next notice is the close: it never heard about Dana's Check-in.
    expect(await phone.nextMessage()).toEqual(notice);
    await expect(phone.nextMessage(300)).rejects.toThrow(/timed out/);
    console.close();
    phone.close();
  });
});
