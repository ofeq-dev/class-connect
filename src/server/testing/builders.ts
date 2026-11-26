import type { SessionInput } from "../course";
import type { TestApp } from "./make-test-app";

/** Builders set up state through module operations, never by inserting rows. */
export function aCourse(t: TestApp, name = "Software Engineering") {
  return t.modules.course.createCourse(t.lecturer.id, name);
}

const NAMES = ["Dana Levi", "Omar Haddad", "Irina Petrova", "Noa Cohen", "Yusuf Nasser", "Maya Katz"];

/** A Roster of n Students with IDs 1001, 1002, … */
export function aRoster(t: TestApp, courseId: number, n = 3) {
  return Array.from({ length: n }, (_, i) =>
    t.modules.course.addRosterEntry(courseId, String(1001 + i), NAMES[i % NAMES.length] ?? `Student ${i + 1}`),
  );
}

/** A Session on the fake Clock's day (2026-11-30), 10:00–11:30 unless overridden. */
export function aSession(t: TestApp, courseId: number, input: Partial<SessionInput> = {}) {
  return t.modules.course.createSession(courseId, {
    date: t.modules.course.today(),
    start: "10:00",
    end: "11:30",
    ...input,
  });
}
