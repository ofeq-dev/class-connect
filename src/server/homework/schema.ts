import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// course_id and roster_entry_id refer to Course's tables; Course owns them, so there is no
// cross-module foreign key. Later Homework tables (review, similarity, Help) come with the review run.

export const assignment = sqliteTable(
  "assignment",
  {
    id: integer("id").primaryKey(),
    courseId: integer("course_id").notNull(),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    dueAt: integer("due_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("assignment_course").on(t.courseId)],
);

export const criterion = sqliteTable(
  "criterion",
  {
    id: integer("id").primaryKey(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => assignment.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** 0-based order within the Assignment. */
    position: integer("position").notNull(),
  },
  (t) => [index("criterion_assignment").on(t.assignmentId, t.position)],
);

/** One per Student per Assignment; a replacement overwrites it. Late is worked out from submitted_at and due_at. */
export const submission = sqliteTable(
  "submission",
  {
    id: integer("id").primaryKey(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => assignment.id, { onDelete: "cascade" }),
    rosterEntryId: integer("roster_entry_id").notNull(),
    /** Pasted text, or the text extracted from the PDF. */
    text: text("text").notNull(),
    /** The PDF in the File store; null for pasted text. */
    fileHash: text("file_hash"),
    fileName: text("file_name"),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("submission_assignment_student").on(t.assignmentId, t.rosterEntryId)],
);
