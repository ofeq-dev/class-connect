import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// session_id refers to Course's session table; Course owns it, so there is no cross-module foreign key.

export const transcript = sqliteTable(
  "transcript",
  {
    id: integer("id").primaryKey(),
    sessionId: integer("session_id").notNull(),
    /** The uploaded file in the File store; null for pasted text. */
    fileHash: text("file_hash"),
    fileName: text("file_name"),
    /** VTT cue numbers stripped, timestamps kept as [hh:mm:ss]. */
    text: text("text").notNull(),
    hasTimestamps: integer("has_timestamps", { mode: "boolean" }).notNull(),
    uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("transcript_session").on(t.sessionId)],
);

export const summary = sqliteTable(
  "summary",
  {
    id: integer("id").primaryKey(),
    sessionId: integer("session_id").notNull(),
    publishedVersionId: integer("published_version_id"),
    /** The latest summary.generate job; its status is the "Summarising…" / failed state. */
    generationJobId: integer("generation_job_id"),
  },
  (t) => [uniqueIndex("summary_session").on(t.sessionId)],
);

export const summaryVersion = sqliteTable(
  "summary_version",
  {
    id: integer("id").primaryKey(),
    summaryId: integer("summary_id")
      .notNull()
      .references(() => summary.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    markdown: text("markdown").notNull(),
    /** ai | lecturer */
    author: text("author").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("summary_version_summary").on(t.summaryId, t.number)],
);
