import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aCourse, aRoster, aSession, listen, makeTestApp, openSse, signInLecturer, type TestApp } from "../testing";

let t: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let cookie: string;

beforeEach(async () => {
  t = makeTestApp();
  server = await listen(t);
  cookie = await signInLecturer(server.url);
});
afterEach(async () => {
  await server.close();
  t.close();
});

const call = (method: string, path: string, json?: unknown) =>
  fetch(`${server.url}/api/lecturer${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });

describe("Course desk over HTTP", () => {
  it("imports a Roster CSV and reports per row", async () => {
    const { id } = aCourse(t);
    const res = await call("POST", `/courses/${id}/roster/import`, { csv: "Name,Student ID\nDana Levi,1001\n,1002" });
    expect(await res.json()).toEqual({
      added: 1,
      alreadyOnRoster: 0,
      problems: [{ line: 3, reason: "No name.", raw: ", 1002" }],
    });
    const roster = await (await call("GET", `/courses/${id}/roster`)).json();
    expect(roster).toMatchObject([{ studentId: "1001", name: "Dana Levi", claimed: false }]);
  });

  it("creates, edits and deletes Sessions, and lists them with today's date", async () => {
    const { id } = aCourse(t);
    const created = await (await call("POST", `/courses/${id}/sessions`, { date: "2026-11-30", start: "10:00", end: "11:30" })).json();
    const moved = await call("PATCH", `/courses/${id}/sessions/${created.id}`, { start: "10:15" });
    expect(await moved.json()).toMatchObject({ start: "10:15", qrCode: created.qrCode });

    const listed = await (await call("GET", `/courses/${id}/sessions`)).json();
    expect(listed).toMatchObject({ today: "2026-11-30", sessions: [{ id: created.id }] });

    expect((await call("DELETE", `/courses/${id}/sessions/${created.id}`)).status).toBe(200);
    expect((await call("GET", `/courses/${id}/sessions/${created.id}`)).status).toBe(404);
  });

  it("answers 404 for an unknown Course or a Session of another Course, and 400 for a bad Session", async () => {
    const a = aCourse(t, "A");
    const b = aCourse(t, "B");
    const s = t.modules.course.createSession(a.id, { date: "2026-11-30", start: "10:00", end: "11:00" });
    expect((await call("GET", "/courses/999")).status).toBe(404);
    expect((await call("GET", "/courses/abc/roster")).status).toBe(404);
    expect((await call("GET", `/courses/${b.id}/sessions/${s.id}`)).status).toBe(404);
    const bad = await call("POST", `/courses/${a.id}/sessions`, { date: "2026-11-30", start: "11:00", end: "10:00" });
    expect(bad.status).toBe(400);
  });

  it("sends a Course page only its own Course's notices, plus Lecturer-wide ones", async () => {
    const a = aCourse(t, "A");
    const b = aCourse(t, "B");
    const page = await openSse(`${server.url}/api/lecturer/events?course=${a.id}`, cookie);
    await page.next(); // connected

    await call("POST", `/courses/${b.id}/roster`, { studentId: "1", name: "In B" });
    await call("POST", `/courses/${a.id}/roster`, { studentId: "1", name: "In A" });
    expect(await page.nextMessage()).toEqual({ type: "roster.changed", id: a.id });

    await call("PATCH", `/courses/${b.id}`, { name: "B renamed" });
    expect(await page.nextMessage()).toEqual({ type: "course.changed", id: b.id });
    page.close();
  });

  it("refuses a stream for a Course that doesn't exist", async () => {
    expect((await fetch(`${server.url}/api/lecturer/events?course=999`, { headers: { cookie } })).status).toBe(404);
  });

  it("downloads the Attendance sheet as xlsx, named for the Course and today", async () => {
    const { id } = aCourse(t);
    aRoster(t, id, 2);
    aSession(t, id);
    const res = await call("GET", `/courses/${id}/attendance.xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Software Engineering attendance 2026-11-30.xlsx"; ` +
        `filename*=UTF-8''Software%20Engineering%20attendance%202026-11-30.xlsx`,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]); // a zip, as every xlsx is
  });

  it("keeps a non-Latin Course name in the xlsx file name, with a plain fallback", async () => {
    const { id } = aCourse(t, "הנדסת תוכנה / 2");
    const res = await call("GET", `/courses/${id}/attendance.xlsx`);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="2 attendance 2026-11-30.xlsx"; ` +
        `filename*=UTF-8''${encodeURIComponent("הנדסת תוכנה 2 attendance 2026-11-30.xlsx")}`,
    );
  });

  it("escapes an apostrophe in the xlsx file name", async () => {
    const { id } = aCourse(t, "Dana's seminar");
    const res = await call("GET", `/courses/${id}/attendance.xlsx`);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="Dana's seminar attendance 2026-11-30.xlsx"; ` +
        `filename*=UTF-8''Dana%27s%20seminar%20attendance%202026-11-30.xlsx`,
    );
  });

  it("refuses the Attendance sheet without sign-in, or for another Lecturer's Course", async () => {
    const res = await fetch(`${server.url}/api/lecturer/courses/${aCourse(t).id}/attendance.xlsx`);
    expect(res.status).toBe(401);
    expect((await call("GET", "/courses/999/attendance.xlsx")).status).toBe(404);
  });
});
