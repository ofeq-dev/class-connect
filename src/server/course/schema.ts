import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const lecturer = sqliteTable("lecturer", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const course = sqliteTable(
  "course",
  {
    id: integer("id").primaryKey(),
    lecturerId: integer("lecturer_id")
      .notNull()
      .references(() => lecturer.id),
    name: text("name").notNull(),
    /** JSON array of language codes for Session summary translations, e.g. ["ar","ru"]. */
    translationLanguages: text("translation_languages").notNull().default("[]"),
    /** The unguessable secret in the Course's Projector window link, /p/<secret>. Replaceable. */
    projectorSecret: text("projector_secret"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [uniqueIndex("course_projector_secret").on(t.projectorSecret)],
);

export const rosterEntry = sqliteTable(
  "roster_entry",
  {
    id: integer("id").primaryKey(),
    courseId: integer("course_id")
      .notNull()
      .references(() => course.id, { onDelete: "cascade" }),
    studentId: text("student_id").notNull(),
    name: text("name").notNull(),
    /** Hash of the device token that claimed this entry (ADR 0002); null when unclaimed. */
    deviceTokenHash: text("device_token_hash"),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("roster_entry_course_student").on(t.courseId, t.studentId)],
);

export const session = sqliteTable(
  "session",
  {
    id: integer("id").primaryKey(),
    courseId: integer("course_id")
      .notNull()
      .references(() => course.id, { onDelete: "cascade" }),
    /** Local date and wall-clock times in the app's time zone: YYYY-MM-DD, HH:MM. */
    date: text("date").notNull(),
    start: text("start").notNull(),
    end: text("end").notNull(),
    /** The fixed code in the Session's QR link, https://cc.ofeq.dev/s/<code>. */
    qrCode: text("qr_code").notNull(),
    /** What the Projector window shows for this Session ("qr" or "blank"; "poll" comes with Polls). Null until set. */
    projectorMode: text("projector_mode", { enum: ["qr", "blank"] }),
    /** The Poll on screen in Poll mode (no foreign key until the Polls ticket adds the table). */
    projectedPollId: integer("projected_poll_id"),
    /** When projectorMode was last set: the Projector window shows the Course's most recent. */
    projectorSetAt: integer("projector_set_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("session_qr_code").on(t.qrCode), index("session_course_date").on(t.courseId, t.date)],
);
