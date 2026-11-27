import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

/**
 * A single-choice Poll. Whether it is a draft, scheduled, open or closed is worked out from these
 * times and the Clock when read, never stored as a flag; a manual open or close wins over the
 * schedule. A draft may be incomplete (no question, fewer than two options) but can't open.
 */
export const poll = sqliteTable(
  "poll",
  {
    id: integer("id").primaryKey(),
    topicId: integer("topic_id")
      .notNull()
      .references(() => topic.id),
    question: text("question").notNull(),
    /** When the Poll opens by itself ("Opens at a time"); null for Opens now or later. */
    scheduledOpenAt: integer("scheduled_open_at", { mode: "timestamp_ms" }),
    /** "Closes after N min", counted from whenever it opens; null for "when I close it". */
    closeAfterMinutes: integer("close_after_minutes"),
    /** The Lecturer's manual open and close. */
    openedAt: integer("opened_at", { mode: "timestamp_ms" }),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("poll_topic").on(t.topicId)],
);

export const pollOption = sqliteTable(
  "poll_option",
  {
    id: integer("id").primaryKey(),
    pollId: integer("poll_id")
      .notNull()
      .references(() => poll.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [index("poll_option_poll").on(t.pollId, t.position)],
);

/** One Vote per Poll per Roster entry; changing it replaces the row. */
export const vote = sqliteTable(
  "vote",
  {
    id: integer("id").primaryKey(),
    pollId: integer("poll_id")
      .notNull()
      .references(() => poll.id, { onDelete: "cascade" }),
    rosterEntryId: integer("roster_entry_id").notNull(),
    optionId: integer("option_id")
      .notNull()
      .references(() => pollOption.id, { onDelete: "cascade" }),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("vote_one_per_entry").on(t.pollId, t.rosterEntryId)],
);
