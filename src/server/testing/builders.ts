import type { TestApp } from "./make-test-app";

/** Builders set up state through module operations, never by inserting rows. */
export function aCourse(t: TestApp, name = "Software Engineering") {
  return t.modules.course.createCourse(t.lecturer.id, name);
}
