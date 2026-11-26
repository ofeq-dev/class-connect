import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
let code: string;

beforeEach(async () => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  aRoster(t, courseId, 3); // 1001 Dana Levi, 1002 Omar Haddad, …
  code = aSession(t, courseId).qrCode;
  server = await listen(t);
});
afterEach(async () => {
  await server.close();
  t.close();
});

const FOUR_HUNDRED_DAYS = 400 * 24 * 60 * 60;

function post(path: string, body: unknown, cookie = "") {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}
const get = (path: string, cookie = "") => fetch(`${server.url}${path}`, { headers: { cookie } });

async function claim(studentId = "1001", cookie = "") {
  const res = await post(`/api/student/s/${code}/claim`, { studentId }, cookie);
  expect(res.status).toBe(200);
  return { res, cookie: cookieHeader(res) };
}

describe("The QR entry page", () => {
  it("names the Course and Session and asks an unclaimed phone to claim", async () => {
    const res = await get(`/api/student/s/${code}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ course: { name: "Software Engineering" }, me: null });
  });

  it("returns 404 for an unknown QR code", async () => {
    expect((await get(`/api/student/s/nope`)).status).toBe(404);
  });
});

describe("Claiming", () => {
  it("looks up the name for the confirm step without binding anything", async () => {
    const res = await post(`/api/student/s/${code}/lookup`, { studentId: "1002" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Omar Haddad" });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(t.modules.course.findRosterEntry(courseId, "1002")?.claimed).toBe(false);
  });

  it("refuses an unknown student ID, at lookup and at claim", async () => {
    const lookup = await post(`/api/student/s/${code}/lookup`, { studentId: "9999" });
    expect(lookup.status).toBe(400);
    expect(await lookup.json()).toMatchObject({ error: "claim.unknown-student" });
    const res = await post(`/api/student/s/${code}/claim`, { studentId: "9999" });
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("says an entry claimed by another phone is already claimed", async () => {
    await claim("1001");
    const lookup = await post(`/api/student/s/${code}/lookup`, { studentId: "1001" });
    expect(lookup.status).toBe(400);
    expect(await lookup.json()).toMatchObject({ error: "claim.already-claimed" });
    const res = await post(`/api/student/s/${code}/claim`, { studentId: "1001" });
    expect(await res.json()).toMatchObject({ error: "claim.already-claimed" });
  });

  it("sets the device-token cookie: httpOnly, Secure, SameSite=Lax, 400 days", async () => {
    const { res } = await claim();
    expect(await res.json()).toMatchObject({ name: "Dana Levi", studentId: "1001" });
    const [cookie] = res.headers.getSetCookie();
    expect(cookie).toMatch(/^cc_device=[A-Za-z0-9_-]{40,};/);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toContain(`; Max-Age=${FOUR_HUNDRED_DAYS}`);
  });

  it("then shows the claimed phone as that Student on the QR page and in the app", async () => {
    const { cookie } = await claim();
    expect(await (await get(`/api/student/s/${code}`, cookie)).json()).toMatchObject({
      me: { name: "Dana Levi" },
    });
    expect(await (await get(`/api/student/me`, cookie)).json()).toMatchObject({
      claimed: true,
      course: { id: courseId, name: "Software Engineering" },
      me: { name: "Dana Levi" },
      session: { qrCode: code },
    });
  });
});

describe("Student identity", () => {
  it("refreshes the cookie with the full attributes on each visit", async () => {
    const { cookie } = await claim();
    for (const path of ["/api/student/me", `/api/student/s/${code}`]) {
      const res = await get(path, cookie);
      const [set] = res.headers.getSetCookie();
      expect(set).toBe(`${cookie}; Max-Age=${FOUR_HUNDRED_DAYS}; Path=/; HttpOnly; Secure; SameSite=Lax`);
    }
  });

  it("treats an unknown token as unclaimed and doesn't refresh it", async () => {
    const res = await get("/api/student/me", "cc_device=made-up-token");
    expect(await res.json()).toEqual({ claimed: false });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await (await get(`/api/student/s/${code}`, "cc_device=made-up-token")).json()).toMatchObject({
      me: null,
    });
  });

  it("treats a reset Claim's token as unclaimed", async () => {
    const { cookie } = await claim();
    const entry = t.modules.course.findRosterEntry(courseId, "1001")!;
    t.modules.course.resetClaim(courseId, entry.id);
    expect(await (await get("/api/student/me", cookie)).json()).toEqual({ claimed: false });
  });

  it("doesn't accept the Lecturer's cookie as a Student", async () => {
    const lecturer = await signInLecturer(server.url);
    expect(await (await get("/api/student/me", lecturer)).json()).toEqual({ claimed: false });
    expect((await get("/api/student/events", lecturer)).status).toBe(401);
  });

  it("keeps the phone's token when it claims on a second Course", async () => {
    const { cookie } = await claim();
    const other = aCourse(t, "Algorithms").id;
    t.modules.course.addRosterEntry(other, "1001", "Dana Levi");
    const otherCode = aSession(t, other).qrCode;
    const res = await post(`/api/student/s/${otherCode}/claim`, { studentId: "1001" }, cookie);
    expect(res.status).toBe(200);
    expect(cookieHeader(res)).toBe(cookie);
    expect(await (await get(`/api/student/s/${code}`, cookie)).json()).toMatchObject({ me: { name: "Dana Levi" } });
  });
});

describe("The Student stream", () => {
  it("refuses an unclaimed phone and streams the claimed Student's Course notices", async () => {
    expect((await get("/api/student/events")).status).toBe(401);
    const { cookie } = await claim();
    const stream = await openSse(`${server.url}/api/student/events`, cookie);
    expect(stream.status).toBe(200);
    await stream.next(); // ": connected"
    const other = aCourse(t, "Algorithms").id;
    aSession(t, other);
    const session = aSession(t, courseId, { start: "12:00", end: "13:00" });
    expect(await stream.nextMessage()).toEqual({ type: "session.changed", id: session.id });
    stream.close();
  });
});
