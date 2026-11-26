import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../errors";
import { aCourse, makeTestApp, type TestApp } from "../testing";

let t: TestApp;
beforeEach(() => (t = makeTestApp()));
afterEach(() => t.close());

describe("Course", () => {
  it("creates a Course and lists the Lecturer's Courses by name", () => {
    aCourse(t, "Software Engineering");
    aCourse(t, "Algorithms");
    expect(t.modules.course.listCourses(t.lecturer.id).map((c) => c.name)).toEqual([
      "Algorithms",
      "Software Engineering",
    ]);
  });

  it("stamps the Course with the Clock's time", () => {
    t.fakes.clock.set("2026-12-01T09:30:00.000Z");
    expect(aCourse(t).createdAt).toBe("2026-12-01T09:30:00.000Z");
  });

  it("trims the name and refuses an empty or overlong one", () => {
    expect(aCourse(t, "  Databases  ").name).toBe("Databases");
    expect(() => aCourse(t, "   ")).toThrow(DomainError);
    expect(() => aCourse(t, "x".repeat(101))).toThrow(DomainError);
  });

  it("notifies the Lecturer scope, and only the Lecturer, when a Course is created", () => {
    const created = aCourse(t);
    expect(t.fakes.events.published).toEqual([
      { courseId: null, audience: "lecturer", notice: { type: "course.changed", id: created.id } },
    ]);
  });

  it("keeps a single Lecturer row across restarts and follows a renamed Lecturer", () => {
    const again = t.modules.course.ensureLecturer("Dr. Renamed");
    expect(again.id).toBe(t.lecturer.id);
    expect(again.name).toBe("Dr. Renamed");
  });
});
