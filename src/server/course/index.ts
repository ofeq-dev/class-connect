import { asc, eq } from "drizzle-orm";
import type { Clock } from "../clock";
import type { Db } from "../db";
import { DomainError } from "../errors";
import type { LiveEvents } from "../live-events";
import { course, lecturer } from "./schema";

export interface Lecturer {
  id: number;
  name: string;
}

export interface Course {
  id: number;
  name: string;
  createdAt: string;
}

export interface CourseModule {
  /** The one Lecturer (real accounts are v2). Creates the row on first start. */
  ensureLecturer(name: string): Lecturer;
  createCourse(lecturerId: number, name: string): Course;
  listCourses(lecturerId: number): Course[];
}

export interface CourseDeps {
  db: Db;
  clock: Clock;
  events: LiveEvents;
}

const MAX_NAME = 100;

export function createCourseModule({ db, clock, events }: CourseDeps): CourseModule {
  const toCourse = (row: typeof course.$inferSelect): Course => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
  });

  return {
    ensureLecturer(name) {
      const existing = db.select().from(lecturer).limit(1).get();
      if (existing) {
        if (existing.name !== name) {
          db.update(lecturer).set({ name }).where(eq(lecturer.id, existing.id)).run();
        }
        return { id: existing.id, name };
      }
      return db.insert(lecturer).values({ name }).returning().get();
    },

    createCourse(lecturerId, rawName) {
      const name = rawName.trim();
      if (!name) throw new DomainError("course.name-required", "A Course needs a name.");
      if (name.length > MAX_NAME) {
        throw new DomainError("course.name-too-long", `Keep the name under ${MAX_NAME} characters.`);
      }
      const row = db
        .insert(course)
        .values({ lecturerId, name, createdAt: clock.now() })
        .returning()
        .get();
      events.publish(null, "lecturer", { type: "course.changed", id: row.id });
      return toCourse(row);
    },

    listCourses(lecturerId) {
      return db
        .select()
        .from(course)
        .where(eq(course.lecturerId, lecturerId))
        .orderBy(asc(course.name))
        .all()
        .map(toCourse);
    },
  };
}
