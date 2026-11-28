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

describe("Network approval and Manual marks, from the console", () => {
  const CARRIER = "2.54.17.3";
  beforeEach(async () => {
    await openWindow();
  });

  const glance = async (query = "") => (await get(`${attendancePath()}${query}`, lecturer)).json();
  const approve = (key: string, cookie = lecturer) => post(`${attendancePath()}/networks/${key}/approve`, {}, cookie);
  const mark = (rosterEntryId: number, present: boolean | null, cookie = lecturer) =>
    post(`${attendancePath()}/marks/${rosterEntryId}`, { present }, cookie);

  it("approves a Pending network by its card's key, and the Student's phone hears it", async () => {
    const omar = claimed("1002");
    await scan(omar, CARRIER);
    const phone = await openSse(`${server.url}/api/student/events`, omar);
    await phone.next();
    const { networks } = await glance();
    expect(networks).toEqual([{ key: expect.any(String), students: [{ rosterEntryId: expect.any(Number), name: "Omar Haddad" }] }]);

    const res = await approve(networks[0].key);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ present: 1, pending: 0, networks: [] });
    expect(await phone.nextMessage()).toEqual({ type: "attendance.changed", id: session.id });
    expect(await (await get("/api/student/me", omar)).json()).toMatchObject({ checkIn: { status: "present" } });
    phone.close();
  });

  it("refuses an unknown network key, and a request without the Lecturer's cookie", async () => {
    await scan(claimed("1002"), CARRIER);
    const { networks } = await glance();
    expect((await approve("nonsense")).status).toBe(404);
    expect((await approve(networks[0].key, "")).status).toBe(401);
  });

  it("Manual marks present, absent and clear, with the window closed too", async () => {
    await post(`${attendancePath()}/window/close`, {}, lecturer);
    const dana = t.modules.course.findRosterEntry(courseId, "1001")!;
    expect(await (await mark(dana.id, true)).json()).toMatchObject({ present: 1 });
    expect(await (await mark(dana.id, false)).json()).toMatchObject({ present: 0 });
    const cleared = await (await mark(dana.id, null)).json();
    expect(cleared.students.find((s: { rosterEntryId: number }) => s.rosterEntryId === dana.id)).toMatchObject({
      status: "absent",
      mark: null,
    });
    const other = aRoster(t, aCourse(t, "Algorithms").id, 1)[0]!;
    expect((await mark(other.id, true)).status).toBe(404);
    expect((await mark(dana.id, true, "")).status).toBe(401);
  });

  it("never sends a Student's phone a notice naming another Student", async () => {
    const omar = claimed("1002");
    const dana = claimed("1001");
    const phone = await openSse(`${server.url}/api/student/events`, omar);
    await phone.next();
    await scan(dana, CARRIER);
    const danaEntry = t.modules.course.findRosterEntry(courseId, "1001")!;
    await approve((await glance()).networks[0].key);
    await mark(danaEntry.id, false);
    const seen = [await phone.nextMessage(), await phone.nextMessage()];
    expect(seen).toEqual(Array(2).fill({ type: "attendance.changed", id: session.id }));
    await expect(phone.nextMessage(300)).rejects.toThrow(/timed out/);
    phone.close();
  });

  it("shows no IP address in any response the console renders unless Diagnostics is on", async () => {
    await scan(claimed("1001"), "147.235.10.99");
    await scan(claimed("1002"), CARRIER);
    const dana = t.modules.course.findRosterEntry(courseId, "1001")!;
    const bodies = [
      JSON.stringify(await glance()),
      await (await mark(dana.id, true)).text(),
      await (await post(`${attendancePath()}/window/open`, { ipv4: CLASSROOM }, lecturer)).text(),
    ];
    for (const body of bodies) {
      expect(body).not.toMatch(/147\.235|2\.54\.17|\/24|deviceId/);
    }
    const diag = JSON.stringify(await glance("?diagnostics=1"));
    expect(diag).toContain("2.54.17.0/24");
    expect(diag).toContain("147.235.10.99");
    const key = (await glance()).networks[0].key;
    expect(await (await post(`${attendancePath()}/networks/${key}/approve?diagnostics=1`, {}, lecturer)).text()).toContain(
      "2.54.17.3",
    );
  });
});

describe("Held scans after a Manual absent mark, from the console", () => {
  beforeEach(async () => {
    await openWindow();
  });

  const glance = async () => (await get(attendancePath(), lecturer)).json();
  const mark = (rosterEntryId: number, present: boolean | null) =>
    post(`${attendancePath()}/marks/${rosterEntryId}`, { present }, lecturer);
  const decide = (rosterEntryId: number, decision: "allow" | "keep-absent", cookie = lecturer) =>
    post(`${attendancePath()}/held/${rosterEntryId}/${decision}`, {}, cookie);

  it("holds the scan, leaving the Student Absent, and the console hears of it live", async () => {
    const dana = claimed("1001");
    const danaEntry = t.modules.course.findRosterEntry(courseId, "1001")!;
    await mark(danaEntry.id, false);
    const console = await openSse(`${server.url}/api/lecturer/events?course=${courseId}`, lecturer);
    await console.next();

    const res = await scan(dana, CLASSROOM);
    expect(await res.json()).toMatchObject({ checkIn: { status: "held" } });
    expect(await console.nextMessage()).toEqual({ type: "attendance.changed", id: session.id });
    expect(await glance()).toMatchObject({ present: 0, held: [{ rosterEntryId: danaEntry.id, name: "Dana Levi" }] });
    expect(await (await get("/api/student/me", dana)).json()).toMatchObject({ checkIn: { status: "held" } });
    console.close();
  });

  it("allows a held scan after class: Present at the scan's time, and the phone hears it", async () => {
    const dana = claimed("1001");
    const danaEntry = t.modules.course.findRosterEntry(courseId, "1001")!;
    await mark(danaEntry.id, false);
    await scan(dana, CLASSROOM);
    const scannedAt = t.modules.attendance.heldScans(session.id)[0]!.at;
    await post(`${attendancePath()}/window/close`, {}, lecturer);
    t.fakes.clock.advance(60 * 60_000);
    const phone = await openSse(`${server.url}/api/student/events`, dana);
    await phone.next();

    const res = await decide(danaEntry.id, "allow");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ present: 1, held: [] });
    expect(body.students.find((s: { rosterEntryId: number }) => s.rosterEntryId === danaEntry.id)).toMatchObject({
      status: "present",
      at: scannedAt,
    });
    expect(await phone.nextMessage()).toEqual({ type: "attendance.changed", id: session.id });
    expect(await (await get("/api/student/me", dana)).json()).toMatchObject({ checkIn: { status: "present", at: scannedAt } });
    phone.close();
  });

  it("keeps a Student absent, logging the decision", async () => {
    const danaEntry = t.modules.course.findRosterEntry(courseId, "1001")!;
    await mark(danaEntry.id, false);
    await scan(claimed("1001"), CLASSROOM);
    expect(await (await decide(danaEntry.id, "keep-absent")).json()).toMatchObject({ present: 0, held: [] });
    expect(t.modules.attendance.heldScans(session.id)).toEqual([expect.objectContaining({ decision: "kept-absent" })]);
  });

  it("refuses a Student with nothing held, and a request without the Lecturer's cookie", async () => {
    const danaEntry = t.modules.course.findRosterEntry(courseId, "1001")!;
    expect((await decide(danaEntry.id, "allow")).status).toBe(404);
    await mark(danaEntry.id, false);
    await scan(claimed("1001"), CLASSROOM);
    expect((await decide(danaEntry.id, "allow", "")).status).toBe(401);
  });
});
