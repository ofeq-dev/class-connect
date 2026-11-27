import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// session_id and roster_entry_id refer to Course's tables; Course owns them, so there is no
// cross-module foreign key.

/** One row per opening of a Session's Check-in window (ADR 0001). */
export const checkInWindow = sqliteTable(
  "check_in_window",
  {
    id: integer("id").primaryKey(),
    sessionId: integer("session_id").notNull(),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }).notNull(),
    /** Set when the Lecturer closes it. The midnight close is read from the Clock, never stored. */
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    /** The Lecturer's own addresses when the window opened; either may be missing. */
    lecturerIpv4: text("lecturer_ipv4"),
    lecturerIpv6: text("lecturer_ipv6"),
  },
  (t) => [index("check_in_window_session").on(t.sessionId, t.openedAt)],
);

/**
 * At most one row per Session per Roster entry, overwritten so the latest action wins: state is
 * what counts, a Check-in result or a Manual mark.
 * Absent is not stored: no row, or a Pending row once the window has closed.
 */
export const attendance = sqliteTable(
  "attendance",
  {
    id: integer("id").primaryKey(),
    sessionId: integer("session_id").notNull(),
    rosterEntryId: integer("roster_entry_id").notNull(),
    state: text("state", { enum: ["present", "pending", "manual-present", "manual-absent"] }).notNull(),
    /**
     * What the Student's own Check-in recorded, kept under a Manual mark so clearing the mark
     * restores it; null when they never checked in.
     */
    checkInState: text("check_in_state", { enum: ["present", "pending"] }),
    /** The Check-in's client IP and its /24 or /64 block; null when they never checked in. */
    ip: text("ip"),
    block: text("block"),
    /** Hash of the device token that checked in (ADR 0002); the raw token is never stored. */
    deviceTokenHash: text("device_token_hash"),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("attendance_session_entry").on(t.sessionId, t.rosterEntryId)],
);

/**
 * A network block the Lecturer approved for one Session (ADR 0001, amended): Check-ins from it
 * count as Present for that Session only. Never carried to another Session.
 */
export const approvedNetwork = sqliteTable(
  "approved_network",
  {
    id: integer("id").primaryKey(),
    sessionId: integer("session_id").notNull(),
    /** "a.b.c.0/24" or "h:h:h:h::/64", as blockOf() writes it. */
    block: text("block").notNull(),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("approved_network_session_block").on(t.sessionId, t.block)],
);
