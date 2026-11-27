import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../errors";
import type { Notice } from "../../shared/notices";
import { aClaimedStudent, aCourse, aRoster, aSession, makeTestApp, type TestApp } from "../testing";

let t: TestApp;
let courseId: number;
beforeEach(() => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  t.fakes.events.clear();
});
afterEach(() => t.close());

const course = () => t.modules.course;

describe("The projector link", () => {
  it("gives each Course its own unguessable secret, which resolves to that Course", () => {
    const other = aCourse(t, "Algorithms").id;
    const secret = course().projectorSecret(courseId);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(course().projectorSecret(other)).not.toBe(secret);
    expect(course().projectorCourse(secret)).toMatchObject({ id: courseId, name: "Software Engineering" });
  });

  it("resolves nothing for an unknown or empty secret", () => {
    expect(course().projectorCourse("not-a-secret")).toBeNull();
    expect(course().projectorCourse("")).toBeNull();
  });

  it("replaces the link with a new one, and the old secret resolves nothing", () => {
    const old = course().projectorSecret(courseId);
    const fresh = course().newProjectorLink(courseId);
    expect(fresh).not.toBe(old);
    expect(course().projectorSecret(courseId)).toBe(fresh);
    expect(course().projectorCourse(old)).toBeNull();
    expect(course().projectorCourse(fresh)).toMatchObject({ id: courseId });
  });

  it("tells a window still open on the old link that its projection changed", () => {
    course().newProjectorLink(courseId);
    expect(t.fakes.events.published).toEqual([
      { courseId, audience: "projector", notice: { type: "projector.changed", id: courseId } },
      { courseId, audience: "lecturer", notice: { type: "projector.changed", id: courseId } },
    ]);
  });
});

describe("Projector mode", () => {
  it("is Blank for a Course none of whose Sessions has been projected", () => {
    aSession(t, courseId);
    expect(course().projection(courseId)).toEqual({ mode: "blank", session: null });
  });

  it("shows the Session whose mode was set most recently", () => {
    const monday = aSession(t, courseId, { date: "2026-11-30" });
    const tuesday = aSession(t, courseId, { date: "2026-12-01" });
    course().updateSession(tuesday.id, { projectorMode: "qr" });
    t.fakes.clock.advance(1000);
    course().updateSession(monday.id, { projectorMode: "qr" });
    expect(course().projection(courseId)).toEqual({ mode: "qr", session: { ...monday, projectorMode: "qr" } });

    t.fakes.clock.advance(1000);
    course().updateSession(tuesday.id, { projectorMode: "blank" });
    expect(course().projection(courseId)).toMatchObject({ mode: "blank", session: { id: tuesday.id } });
  });

  it("ignores another Course's Sessions", () => {
    const other = aSession(t, aCourse(t, "Algorithms").id);
    course().updateSession(other.id, { projectorMode: "qr" });
    expect(course().projection(courseId)).toEqual({ mode: "blank", session: null });
  });

  it("is stored on the Session and keeps its times", () => {
    const s = aSession(t, courseId);
    expect(s.projectorMode).toBeNull();
    const projected = course().updateSession(s.id, { projectorMode: "qr" });
    expect(projected).toEqual({ ...s, projectorMode: "qr" });
    expect(course().readSession(s.id).projectorMode).toBe("qr");
  });

  it("refuses a mode it doesn't know", () => {
    const s = aSession(t, courseId);
    expect(() => course().updateSession(s.id, { projectorMode: "poll" as "qr" })).toThrow(DomainError);
  });

  it("publishes projector.changed to the Projector scope and the Lecturer, and nothing to Students", () => {
    const s = aSession(t, courseId);
    t.fakes.events.clear();
    course().updateSession(s.id, { projectorMode: "qr" });
    expect(t.fakes.events.published).toEqual([
      { courseId, audience: "projector", notice: { type: "projector.changed", id: courseId } },
      { courseId, audience: "lecturer", notice: { type: "projector.changed", id: courseId } },
    ]);
  });

  it("still tells everyone when the Session's times change", () => {
    const s = aSession(t, courseId);
    t.fakes.events.clear();
    course().updateSession(s.id, { end: "12:00", projectorMode: "blank" });
    expect(t.fakes.events.published.map((p) => [p.audience, p.notice.type])).toEqual([
      ["all", "session.changed"],
      ["projector", "projector.changed"],
      ["lecturer", "projector.changed"],
    ]);
  });

  it("tells the projector when the projected Session is deleted, and falls back to Blank", () => {
    const s = aSession(t, courseId);
    course().updateSession(s.id, { projectorMode: "qr" });
    t.fakes.events.clear();
    course().deleteSession(s.id);
    expect(t.fakes.events.published.map((p) => [p.audience, p.notice.type])).toContainEqual([
      "projector",
      "projector.changed",
    ]);
    expect(course().projection(courseId)).toEqual({ mode: "blank", session: null });
  });
});

describe("The Projector scope", () => {
  it("hears only projector changes and the checked-in count: never names, Check-ins pending, or Session details", () => {
    const heard: Notice[] = [];
    t.fakes.events.subscribe({ courseId, role: "projector" }, (n) => heard.push(n));
    const s = aSession(t, courseId);
    const [dana, omar] = aRoster(t, courseId, 2);
    aClaimedStudent(t, courseId, dana!.studentId);
    course().updateSession(s.id, { projectorMode: "qr" });
    t.modules.attendance.openWindow(s.id, { ipv4: "147.235.10.20", ipv6: null });
    t.modules.attendance.checkIn(s.id, omar!.id, "2.54.1.1", "device-omar"); // Pending
    t.modules.attendance.checkIn(s.id, dana!.id, "147.235.10.21", "device-dana"); // Present
    course().updateSession(s.id, { end: "12:00" });
    course().updateSession(s.id, { projectorMode: "blank" });

    expect(heard).toEqual([
      { type: "projector.changed", id: courseId },
      { type: "attendance.changed", id: s.id }, // window opened
      { type: "attendance.changed", id: s.id }, // Dana present
      { type: "projector.changed", id: courseId },
    ]);
  });
});
