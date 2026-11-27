import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, NotFoundError } from "../errors";
import { aCourse, aSession, makeTestApp, type TestApp } from "../testing";

let t: TestApp;
let courseId: number;
beforeEach(() => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  t.fakes.events.clear();
});
afterEach(() => t.close());

describe("Sessions", () => {
  it("stores the date, start and end, and gives each Session its own QR code", () => {
    const a = aSession(t, courseId, { date: "2026-12-07", start: "09:15", end: "10:45" });
    const b = aSession(t, courseId);
    expect(a).toMatchObject({ date: "2026-12-07", start: "09:15", end: "10:45" });
    expect(a.qrCode).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(b.qrCode).not.toBe(a.qrCode);
  });

  it("reads a Session by id or by its QR code", () => {
    const s = aSession(t, courseId);
    expect(t.modules.course.readSession(s.id)).toEqual(s);
    expect(t.modules.course.readSession(s.qrCode)).toEqual(s);
    expect(() => t.modules.course.readSession("nope")).toThrow(NotFoundError);
  });

  it("lists a Course's Sessions by date, then start time", () => {
    aSession(t, courseId, { date: "2026-12-07", start: "12:00", end: "13:00" });
    aSession(t, courseId, { date: "2026-11-30" });
    aSession(t, courseId, { date: "2026-12-07", start: "09:00", end: "10:00" });
    expect(t.modules.course.listSessions(courseId).map((s) => `${s.date} ${s.start}`)).toEqual([
      "2026-11-30 10:00",
      "2026-12-07 09:00",
      "2026-12-07 12:00",
    ]);
  });

  it("refuses a missing date, a bad time, or an end before the start", () => {
    expect(() => aSession(t, courseId, { date: "" })).toThrow(DomainError);
    expect(() => aSession(t, courseId, { date: "2026-02-31x" })).toThrow(DomainError);
    expect(() => aSession(t, courseId, { start: "25:00" })).toThrow(DomainError);
    expect(() => aSession(t, courseId, { start: "11:00", end: "10:00" })).toThrow(DomainError);
  });

  it("updates a Session, keeping its QR code, and checks the result", () => {
    const s = aSession(t, courseId);
    const moved = t.modules.course.updateSession(s.id, { date: "2026-12-01", end: "12:00" });
    expect(moved).toEqual({ ...s, date: "2026-12-01", end: "12:00" });
    expect(() => t.modules.course.updateSession(s.id, { start: "13:00" })).toThrow(DomainError);
  });

  it("deletes a Session", () => {
    const s = aSession(t, courseId);
    t.modules.course.deleteSession(s.id);
    expect(t.modules.course.listSessions(courseId)).toEqual([]);
    expect(() => t.modules.course.readSession(s.id)).toThrow(NotFoundError);
  });

  it("notifies the Course's Lecturer and Students on every change", () => {
    const s = aSession(t, courseId);
    t.modules.course.updateSession(s.id, { end: "12:00" });
    t.modules.course.deleteSession(s.id);
    expect(t.fakes.events.published).toEqual(
      Array(3).fill({ courseId, audience: "all", notice: { type: "session.changed", id: s.id } }),
    );
  });

  it("knows today's date in the app's time zone, from the Clock", () => {
    t.fakes.clock.set("2026-11-30T22:30:00.000Z"); // 00:30 on 1 December in Israel
    expect(t.modules.course.today()).toBe("2026-12-01");
  });
});
