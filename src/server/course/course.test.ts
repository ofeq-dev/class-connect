import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, NotFoundError } from "../errors";
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

  it("reads only the Lecturer's own Course", () => {
    const created = aCourse(t);
    expect(t.modules.course.readCourse(t.lecturer.id, created.id)).toEqual(created);
    expect(() => t.modules.course.readCourse(t.lecturer.id + 1, created.id)).toThrow(NotFoundError);
    expect(() => t.modules.course.readCourse(t.lecturer.id, 999)).toThrow(NotFoundError);
  });

  it("renames a Course and sets its translation languages, cleaned and checked", () => {
    const { id } = aCourse(t);
    const updated = t.modules.course.updateCourse(id, {
      name: " Software Engineering B ",
      translationLanguages: ["ar", " ru ", "ar", ""],
    });
    expect(updated).toMatchObject({ name: "Software Engineering B", translationLanguages: ["ar", "ru"] });
    expect(() => t.modules.course.updateCourse(id, { translationLanguages: ["Arabic"] })).toThrow(DomainError);
    expect(t.fakes.events.published.at(-1)).toEqual({
      courseId: null,
      audience: "lecturer",
      notice: { type: "course.changed", id },
    });
  });

  it("keeps a single Lecturer row across restarts and follows a renamed Lecturer", () => {
    const again = t.modules.course.ensureLecturer("Dr. Renamed");
    expect(again.id).toBe(t.lecturer.id);
    expect(again.name).toBe("Dr. Renamed");
  });
});
