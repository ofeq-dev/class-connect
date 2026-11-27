import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { localDate, type Clock } from "../clock";
import type { Db } from "../db";
import { DomainError, NotFoundError } from "../errors";
import type { LiveEvents } from "../live-events";
import { readRosterCsv } from "./roster-csv";
import { course, lecturer, rosterEntry, session } from "./schema";

export interface Lecturer {
  id: number;
  name: string;
}

export interface Course {
  id: number;
  name: string;
  translationLanguages: string[];
  createdAt: string;
}

export interface RosterEntry {
  id: number;
  courseId: number;
  studentId: string;
  name: string;
  claimed: boolean;
  claimedAt: string | null;
}

/** A Student resolved from their device token: their Roster entry and its Course. */
export interface Viewer {
  course: Course;
  rosterEntry: RosterEntry;
}

export interface RosterImportReport {
  added: number;
  alreadyOnRoster: number;
  problems: { line: number; reason: string; raw: string }[];
}

export interface Session {
  id: number;
  courseId: number;
  /** YYYY-MM-DD, and HH:MM wall-clock times, in the app's time zone. */
  date: string;
  start: string;
  end: string;
  qrCode: string;
}

export interface SessionInput {
  date: string;
  start: string;
  end: string;
}

export interface CourseModule {
  /** The one Lecturer (real accounts are v2). Creates the row on first start. */
  ensureLecturer(name: string): Lecturer;

  createCourse(lecturerId: number, name: string): Course;
  listCourses(lecturerId: number): Course[];
  /** The Course, if it is this Lecturer's; NotFoundError otherwise. */
  readCourse(lecturerId: number, courseId: number): Course;
  /** A Course's id and name, for a Student's QR page before they have claimed. */
  courseSummary(courseId: number): { id: number; name: string };
  /** The Course's extra languages for Session summary translations, in the Lecturer's order. */
  translationLanguages(courseId: number): string[];
  updateCourse(courseId: number, changes: { name?: string; translationLanguages?: string[] }): Course;

  importRoster(courseId: number, csv: string): RosterImportReport;
  addRosterEntry(courseId: number, studentId: string, name: string): RosterEntry;
  /** The entry with this student ID on the Course's Roster, or null (the "You are <name>?" step). */
  findRosterEntry(courseId: number, studentId: string): RosterEntry | null;
  listRoster(courseId: number): RosterEntry[];
  /**
   * Binds this device to the Roster entry with this student ID (ADR 0002). First claim wins;
   * one device per Student and one Student per device. Only the token's hash is stored.
   */
  claim(courseId: number, studentId: string, deviceToken: string): RosterEntry;
  /**
   * The Student this device token is bound to, in the given Course, or else in the Course it
   * claimed most recently (a Course switcher is v2). Null for a missing, unknown or reset token.
   */
  whoIs(deviceToken: string | undefined, courseId?: number): Viewer | null;
  /** Releases a Claim at once. Never touches attendance. */
  resetClaim(courseId: number, rosterEntryId: number): RosterEntry;

  createSession(courseId: number, input: SessionInput): Session;
  /** By id, or by the code in its QR link. */
  readSession(idOrQrCode: number | string): Session;
  updateSession(sessionId: number, changes: Partial<SessionInput>): Session;
  deleteSession(sessionId: number): void;
  listSessions(courseId: number): Session[];
  /** Today's date in the app's time zone, from the Clock. */
  today(): string;
}

export interface CourseDeps {
  db: Db;
  clock: Clock;
  events: LiveEvents;
  timeZone: string;
}

const MAX_NAME = 100;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function courseName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new DomainError("course.name-required", "A Course needs a name.");
  if (name.length > MAX_NAME) {
    throw new DomainError("course.name-too-long", `Keep the name under ${MAX_NAME} characters.`);
  }
  return name;
}

function languages(raw: string[]): string[] {
  const codes = [...new Set(raw.map((c) => c.trim()).filter(Boolean))];
  const bad = codes.find((c) => !LANGUAGE.test(c));
  if (bad) throw new DomainError("course.bad-language", `"${bad}" isn't a language code like ar or ru.`);
  if (codes.length > 10) throw new DomainError("course.too-many-languages", "Choose at most 10 languages.");
  return codes;
}

/** Only this hash of a device token is ever stored (ADR 0002). */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionTimes(input: SessionInput): SessionInput {
  const { date, start, end } = input;
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new DomainError("session.bad-date", "Choose a date for the Session.");
  }
  if (!TIME.test(start) || !TIME.test(end)) {
    throw new DomainError("session.bad-time", "Choose a start and end time.");
  }
  if (end <= start) throw new DomainError("session.end-before-start", "The Session must end after it starts.");
  return { date, start, end };
}

export function createCourseModule({ db, clock, events, timeZone }: CourseDeps): CourseModule {
  const toCourse = (row: typeof course.$inferSelect): Course => ({
    id: row.id,
    name: row.name,
    translationLanguages: JSON.parse(row.translationLanguages) as string[],
    createdAt: row.createdAt.toISOString(),
  });
  const toEntry = (row: typeof rosterEntry.$inferSelect): RosterEntry => ({
    id: row.id,
    courseId: row.courseId,
    studentId: row.studentId,
    name: row.name,
    claimed: row.deviceTokenHash !== null,
    claimedAt: row.claimedAt?.toISOString() ?? null,
  });
  const toSession = (row: typeof session.$inferSelect): Session => ({
    id: row.id,
    courseId: row.courseId,
    date: row.date,
    start: row.start,
    end: row.end,
    qrCode: row.qrCode,
  });

  const courseChanged = (id: number) => events.publish(null, "lecturer", { type: "course.changed", id });
  const rosterChanged = (courseId: number) =>
    events.publish(courseId, "lecturer", { type: "roster.changed", id: courseId });
  const sessionChanged = (s: { id: number; courseId: number }) =>
    events.publish(s.courseId, "all", { type: "session.changed", id: s.id });

  function courseRow(courseId: number) {
    const row = db.select().from(course).where(eq(course.id, courseId)).get();
    if (!row) throw new NotFoundError("Course");
    return row;
  }
  function sessionRow(sessionId: number) {
    const row = db.select().from(session).where(eq(session.id, sessionId)).get();
    if (!row) throw new NotFoundError("Session");
    return row;
  }
  function entryRow(courseId: number, studentId: string) {
    return db
      .select()
      .from(rosterEntry)
      .where(and(eq(rosterEntry.courseId, courseId), eq(rosterEntry.studentId, studentId)))
      .get();
  }
  function newQrCode(): string {
    for (;;) {
      const code = randomBytes(8).toString("base64url");
      if (!db.select({ id: session.id }).from(session).where(eq(session.qrCode, code)).get()) return code;
    }
  }

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
      const row = db
        .insert(course)
        .values({ lecturerId, name: courseName(rawName), createdAt: clock.now() })
        .returning()
        .get();
      courseChanged(row.id);
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

    readCourse(lecturerId, courseId) {
      const row = courseRow(courseId);
      if (row.lecturerId !== lecturerId) throw new NotFoundError("Course");
      return toCourse(row);
    },

    courseSummary(courseId) {
      const { id, name } = courseRow(courseId);
      return { id, name };
    },

    translationLanguages(courseId) {
      return toCourse(courseRow(courseId)).translationLanguages;
    },

    updateCourse(courseId, changes) {
      courseRow(courseId);
      const set: Partial<typeof course.$inferInsert> = {};
      if (changes.name !== undefined) set.name = courseName(changes.name);
      if (changes.translationLanguages !== undefined) {
        set.translationLanguages = JSON.stringify(languages(changes.translationLanguages));
      }
      const row = db.update(course).set(set).where(eq(course.id, courseId)).returning().get()!;
      courseChanged(courseId);
      return toCourse(row);
    },

    importRoster(courseId, csv) {
      courseRow(courseId);
      const report: RosterImportReport = { added: 0, alreadyOnRoster: 0, problems: [] };
      const seen = new Set<string>();
      db.transaction((tx) => {
        for (const row of readRosterCsv(csv)) {
          if (!row.ok) {
            report.problems.push({ line: row.line, reason: row.reason, raw: row.raw });
            continue;
          }
          if (seen.has(row.studentId)) {
            report.problems.push({
              line: row.line,
              reason: `Student ID ${row.studentId} appears twice in this file.`,
              raw: `${row.name}, ${row.studentId}`,
            });
            continue;
          }
          seen.add(row.studentId);
          if (entryRow(courseId, row.studentId)) {
            report.alreadyOnRoster++;
            continue;
          }
          tx.insert(rosterEntry).values({ courseId, studentId: row.studentId, name: row.name }).run();
          report.added++;
        }
      });
      if (report.added > 0) rosterChanged(courseId);
      return report;
    },

    addRosterEntry(courseId, rawStudentId, rawName) {
      courseRow(courseId);
      const studentId = rawStudentId.trim();
      const name = rawName.trim().replace(/\s+/g, " ");
      if (!studentId) throw new DomainError("roster.student-id-required", "Enter the student ID.");
      if (!name) throw new DomainError("roster.name-required", "Enter the Student's name.");
      if (entryRow(courseId, studentId)) {
        throw new DomainError("roster.duplicate", `Student ID ${studentId} is already on the Roster.`);
      }
      const row = db.insert(rosterEntry).values({ courseId, studentId, name }).returning().get();
      rosterChanged(courseId);
      return toEntry(row);
    },

    findRosterEntry(courseId, studentId) {
      const row = entryRow(courseId, studentId.trim());
      return row ? toEntry(row) : null;
    },

    listRoster(courseId) {
      return db
        .select()
        .from(rosterEntry)
        .where(eq(rosterEntry.courseId, courseId))
        .orderBy(asc(rosterEntry.name))
        .all()
        .map(toEntry);
    },

    claim(courseId, rawStudentId, deviceToken) {
      courseRow(courseId);
      const entry = entryRow(courseId, rawStudentId.trim());
      if (!entry) {
        throw new DomainError("claim.unknown-student", "That student ID isn't on this Course's Roster.");
      }
      const hash = tokenHash(deviceToken);
      if (entry.deviceTokenHash === hash) return toEntry(entry);
      if (entry.deviceTokenHash !== null) {
        throw new DomainError("claim.already-claimed", "Already claimed — ask your Lecturer.");
      }
      const boundHere = db
        .select({ id: rosterEntry.id })
        .from(rosterEntry)
        .where(and(eq(rosterEntry.courseId, courseId), eq(rosterEntry.deviceTokenHash, hash)))
        .get();
      if (boundHere) {
        throw new DomainError(
          "claim.device-already-bound",
          "This phone is already set up for another Student on this Course — ask your Lecturer.",
        );
      }
      const row = db
        .update(rosterEntry)
        .set({ deviceTokenHash: hash, claimedAt: clock.now() })
        .where(eq(rosterEntry.id, entry.id))
        .returning()
        .get()!;
      rosterChanged(courseId);
      return toEntry(row);
    },

    whoIs(deviceToken, courseId) {
      if (!deviceToken) return null;
      const bound = eq(rosterEntry.deviceTokenHash, tokenHash(deviceToken));
      const row = db
        .select()
        .from(rosterEntry)
        .where(courseId === undefined ? bound : and(bound, eq(rosterEntry.courseId, courseId)))
        .orderBy(desc(rosterEntry.claimedAt), desc(rosterEntry.id))
        .limit(1)
        .get();
      if (!row) return null;
      return { course: toCourse(courseRow(row.courseId)), rosterEntry: toEntry(row) };
    },

    resetClaim(courseId, rosterEntryId) {
      const row = db
        .update(rosterEntry)
        .set({ deviceTokenHash: null, claimedAt: null })
        .where(and(eq(rosterEntry.id, rosterEntryId), eq(rosterEntry.courseId, courseId)))
        .returning()
        .get();
      if (!row) throw new NotFoundError("Roster entry");
      rosterChanged(courseId);
      return toEntry(row);
    },

    createSession(courseId, input) {
      courseRow(courseId);
      const row = db
        .insert(session)
        .values({ courseId, ...sessionTimes(input), qrCode: newQrCode() })
        .returning()
        .get();
      sessionChanged(row);
      return toSession(row);
    },

    readSession(idOrQrCode) {
      const row =
        typeof idOrQrCode === "number"
          ? db.select().from(session).where(eq(session.id, idOrQrCode)).get()
          : db.select().from(session).where(eq(session.qrCode, idOrQrCode)).get();
      if (!row) throw new NotFoundError("Session");
      return toSession(row);
    },

    updateSession(sessionId, changes) {
      const current = sessionRow(sessionId);
      const times = sessionTimes({
        date: changes.date ?? current.date,
        start: changes.start ?? current.start,
        end: changes.end ?? current.end,
      });
      const row = db.update(session).set(times).where(eq(session.id, sessionId)).returning().get()!;
      sessionChanged(row);
      return toSession(row);
    },

    deleteSession(sessionId) {
      const row = sessionRow(sessionId);
      db.delete(session).where(eq(session.id, sessionId)).run();
      sessionChanged(row);
    },

    listSessions(courseId) {
      return db
        .select()
        .from(session)
        .where(eq(session.courseId, courseId))
        .orderBy(asc(session.date), asc(session.start))
        .all()
        .map(toSession);
    },

    today() {
      return localDate(clock.now(), timeZone);
    },
  };
}
