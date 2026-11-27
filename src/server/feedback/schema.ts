import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// course_id, session_id and roster_entry_id refer to Course's tables; Course owns them, so
// there is no cross-module foreign key.

/**
 * What a Comment or Poll is about. General and each Session's Topic are listed before anything
 * stores them; a row is written the first time they are listed. Named Topics are the Lecturer's.
 */
export const topic = sqliteTable(
  "topic",
  {
    id: integer("id").primaryKey(),
    courseId: integer("course_id").notNull(),
    kind: text("kind", { enum: ["general", "session", "named"] }).notNull(),
    sessionId: integer("session_id"),
    /** Only named Topics store a name; General and Session Topics are named when read. */
    name: text("name"),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("topic_course").on(t.courseId)],
);

export const comment = sqliteTable(
  "comment",
  {
    id: integer("id").primaryKey(),
    topicId: integer("topic_id")
      .notNull()
      .references(() => topic.id),
    /** Kept for anonymous Comments too; no Lecturer read model ever shows it for one. */
    rosterEntryId: integer("roster_entry_id").notNull(),
    text: text("text").notNull(),
    anonymous: integer("anonymous", { mode: "boolean" }).notNull(),
    /** Against the Session's start and end, on a Session Topic only. */
    timing: text("timing", { enum: ["before", "during", "after"] }),
    status: text("status", { enum: ["new", "pinned", "addressed", "ignored"] }).notNull(),
    /** A quick-reaction key (src/shared/reactions.ts), or null for a typed Comment. */
    reaction: text("reaction"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("comment_topic").on(t.topicId, t.createdAt)],
);
