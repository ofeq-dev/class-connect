import { createHash } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { nextLocalMidnight, type Clock } from "../clock";
import type { CourseModule } from "../course";
import type { Db } from "../db";
import { DomainError, NotFoundError } from "../errors";
import type { LiveEvents } from "../live-events";
import { blockOf } from "./network";
import { approvedNetwork, attendance, checkInWindow } from "./schema";

export type CheckInResult = "present" | "pending";

/** The Lecturer's own addresses, as their browser reported them when opening the window. */
export interface LecturerAddresses {
  ipv4: string | null;
  ipv6: string | null;
}

/** "not-opened" until the Lecturer first opens it; "closed" after a close or at midnight. */
export type WindowState = "not-opened" | "open" | "closed";

export interface CheckInWindow {
  state: WindowState;
  /** When an open window closes by itself (midnight on the Clock); null unless open. */
  closesAt: string | null;
  /** Whether the open window has a Lecturer address of each family to match against. */
  lecturer: { ipv4: boolean; ipv6: boolean } | null;
}

/** The live console's Attendance glance for one Session. */
export interface LecturerAttendance {
  window: CheckInWindow;
  /** Present by Check-in or Manual mark. */
  present: number;
  /** Pending check-ins, while the window is open (they read as Absent once it closes). */
  pending: number;
  /** Roster size. */
  total: number;
}

/** One Session's attendance record for a Roster entry, as Diagnostics shows it. */
export interface CheckInRecord {
  rosterEntryId: number;
  state: "present" | "pending" | "manual-present" | "manual-absent";
  at: string;
  ip: string | null;
  block: string | null;
  /** The first 6 characters of the stored device-token hash; the raw token is never stored. */
  deviceId: string | null;
}

/**
 * A Student's own Check-in line on Today: present (with the time), pending (waiting for the
 * Lecturer), open (not checked in yet), not-opened, or closed (ask the Lecturer).
 */
export interface StudentCheckIn {
  status: "present" | "pending" | "open" | "not-opened" | "closed";
  at: string | null;
}

export interface AttendanceModule {
  /** Opens (or reopens) the window with the Lecturer's addresses; one row per opening. */
  openWindow(sessionId: number, lecturer: LecturerAddresses): void;
  closeWindow(sessionId: number): void;
  /**
   * Records a Check-in from a claimed phone: Present from a Classroom network, else Pending.
   * Refused ("check-in.closed") when the Check-in window isn't open.
   */
  checkIn(sessionId: number, rosterEntryId: number, ip: string, deviceToken: string): CheckInResult;
  isPresent(sessionId: number, rosterEntryId: number): boolean;
  forLecturer(sessionId: number): LecturerAttendance;
  forStudent(sessionId: number, rosterEntryId: number): StudentCheckIn;
  /**
   * Network approval: makes a block a Classroom network for this Session only. Its Pending
   * check-ins turn Present, and so do later Check-ins from it this Session.
   */
  approveNetwork(sessionId: number, block: string): void;
  /**
   * Manual mark: present (true) or absent (false), with the window open, closed or never opened;
   * it replaces whatever was recorded. null clears the mark back to the Student's own Check-in.
   */
  mark(sessionId: number, rosterEntryId: number, present: boolean | null): void;
  /** Every recorded Check-in and mark for a Session, latest action per Roster entry. */
  checkIns(sessionId: number): CheckInRecord[];
  /** The earliest scheduled change after an instant: an open window's midnight close. */
  nextMoment(after: Date): Date | null;
}

export interface AttendanceDeps {
  db: Db;
  clock: Clock;
  events: LiveEvents;
  course: CourseModule;
  timeZone: string;
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const DAY = 24 * 60 * 60 * 1000;
const PRESENT = ["present", "manual-present"] as const;

/** A Lecturer address for one family's slot. The IPv6 slot may hold IPv4-mapped IPv6 (it matches as IPv4). */
function address(raw: string | null, family: 4 | 6): string | null {
  const ip = raw?.trim() || null;
  if (ip === null || (family === 4 ? isIPv4(ip) : isIPv6(ip))) return ip;
  throw new DomainError("check-in.bad-address", `"${ip}" isn't an IPv${family} address.`);
}

export function createAttendanceModule({ db, clock, events, course, timeZone }: AttendanceDeps): AttendanceModule {
  type WindowRow = typeof checkInWindow.$inferSelect;

  function latestWindow(sessionId: number): WindowRow | undefined {
    return db
      .select()
      .from(checkInWindow)
      .where(eq(checkInWindow.sessionId, sessionId))
      .orderBy(desc(checkInWindow.openedAt), desc(checkInWindow.id))
      .limit(1)
      .get();
  }
  const midnightOf = (w: WindowRow) => nextLocalMidnight(w.openedAt, timeZone);
  const isOpen = (w: WindowRow | undefined, now = clock.now()): w is WindowRow =>
    !!w && w.closedAt === null && now < midnightOf(w);

  function openWindowRow(sessionId: number) {
    const w = latestWindow(sessionId);
    return isOpen(w) ? w : null;
  }

  function closeRow(w: WindowRow) {
    db.update(checkInWindow).set({ closedAt: clock.now() }).where(eq(checkInWindow.id, w.id)).run();
  }

  function windowView(sessionId: number): CheckInWindow {
    const w = latestWindow(sessionId);
    if (!w) return { state: "not-opened", closesAt: null, lecturer: null };
    if (!isOpen(w)) return { state: "closed", closesAt: null, lecturer: null };
    return {
      state: "open",
      closesAt: midnightOf(w).toISOString(),
      lecturer: { ipv4: !!w.lecturerIpv4, ipv6: !!w.lecturerIpv6 },
    };
  }

  /** Check-ins name a Student, so only the Lecturer hears of them; window changes go to everyone. */
  const changed = (sessionId: number, audience: "lecturer" | "all") =>
    events.publish(course.readSession(sessionId).courseId, audience, { type: "attendance.changed", id: sessionId });

  function record(sessionId: number, rosterEntryId: number) {
    return db
      .select()
      .from(attendance)
      .where(and(eq(attendance.sessionId, sessionId), eq(attendance.rosterEntryId, rosterEntryId)))
      .get();
  }

  function isApproved(sessionId: number, block: string) {
    return !!db
      .select({ id: approvedNetwork.id })
      .from(approvedNetwork)
      .where(and(eq(approvedNetwork.sessionId, sessionId), eq(approvedNetwork.block, block)))
      .get();
  }

  function requireOpen(sessionId: number, message: string) {
    const window = openWindowRow(sessionId);
    if (!window) throw new DomainError("check-in.closed", message);
    return window;
  }

  return {
    openWindow(sessionId, lecturer) {
      const values = { ipv4: address(lecturer.ipv4, 4), ipv6: address(lecturer.ipv6, 6) };
      course.readSession(sessionId);
      db.transaction(() => {
        const current = openWindowRow(sessionId);
        if (current) closeRow(current);
        db.insert(checkInWindow)
          .values({ sessionId, openedAt: clock.now(), lecturerIpv4: values.ipv4, lecturerIpv6: values.ipv6 })
          .run();
      });
      changed(sessionId, "all");
    },

    closeWindow(sessionId) {
      const current = openWindowRow(sessionId);
      if (!current) return;
      closeRow(current);
      changed(sessionId, "all");
    },

    checkIn(sessionId, rosterEntryId, ip, deviceToken) {
      const window = requireOpen(sessionId, "Check-in is closed — ask the Lecturer to mark you present.");
      const mine = blockOf(ip);
      const reference = [blockOf(window.lecturerIpv4), blockOf(window.lecturerIpv6)];
      const onNetwork = !!mine && (reference.some((r) => r?.block === mine.block) || isApproved(sessionId, mine.block));
      const state: CheckInResult = onNetwork ? "present" : "pending";
      const existing = record(sessionId, rosterEntryId);
      // A Student already present stays present from their first Check-in; scanning again changes nothing.
      if (existing && (PRESENT as readonly string[]).includes(existing.state)) {
        changed(sessionId, "lecturer");
        return "present";
      }
      const row = { state, checkInState: state, ip, block: mine?.block ?? null, deviceTokenHash: tokenHash(deviceToken), at: clock.now() };
      if (existing) db.update(attendance).set(row).where(eq(attendance.id, existing.id)).run();
      else db.insert(attendance).values({ sessionId, rosterEntryId, ...row }).run();
      changed(sessionId, "lecturer");
      return state;
    },

    approveNetwork(sessionId, block) {
      // Once the window closes, Pending check-ins read as Absent; Manual marks fix anyone after that.
      requireOpen(sessionId, "Check-in is closed — mark Students present by hand instead.");
      db.transaction(() => {
        db.insert(approvedNetwork)
          .values({ sessionId, block, approvedAt: clock.now() })
          .onConflictDoNothing()
          .run();
        const fromBlock = and(eq(attendance.sessionId, sessionId), eq(attendance.block, block));
        // A Manual mark stays; the Check-in under it is approved too, for when the mark is cleared.
        db.update(attendance).set({ checkInState: "present" }).where(and(fromBlock, eq(attendance.checkInState, "pending"))).run();
        db.update(attendance).set({ state: "present" }).where(and(fromBlock, eq(attendance.state, "pending"))).run();
      });
      changed(sessionId, "all");
    },
    mark(sessionId, rosterEntryId, present) {
      const { courseId } = course.readSession(sessionId);
      if (!course.listRoster(courseId).some((e) => e.id === rosterEntryId)) throw new NotFoundError("Roster entry");
      const existing = record(sessionId, rosterEntryId);
      if (present === null) {
        if (existing?.checkInState) {
          db.update(attendance).set({ state: existing.checkInState }).where(eq(attendance.id, existing.id)).run();
        } else if (existing) {
          db.delete(attendance).where(eq(attendance.id, existing.id)).run();
        }
      } else {
        const state = present ? "manual-present" : "manual-absent";
        if (existing) db.update(attendance).set({ state, at: clock.now() }).where(eq(attendance.id, existing.id)).run();
        else db.insert(attendance).values({ sessionId, rosterEntryId, state, at: clock.now() }).run();
      }
      changed(sessionId, "all");
    },
    isPresent(sessionId, rosterEntryId) {
      const row = record(sessionId, rosterEntryId);
      return !!row && (PRESENT as readonly string[]).includes(row.state);
    },

    forLecturer(sessionId) {
      const { courseId } = course.readSession(sessionId);
      const roster = new Set(course.listRoster(courseId).map((e) => e.id));
      const window = windowView(sessionId);
      const rows = db
        .select({ rosterEntryId: attendance.rosterEntryId, state: attendance.state })
        .from(attendance)
        .where(and(eq(attendance.sessionId, sessionId), inArray(attendance.state, ["present", "manual-present", "pending"])))
        .all()
        .filter((r) => roster.has(r.rosterEntryId));
      return {
        window,
        present: rows.filter((r) => r.state !== "pending").length,
        pending: window.state === "open" ? rows.filter((r) => r.state === "pending").length : 0,
        total: roster.size,
      };
    },

    forStudent(sessionId, rosterEntryId) {
      const row = record(sessionId, rosterEntryId);
      const window = windowView(sessionId).state;
      if (row && (PRESENT as readonly string[]).includes(row.state)) {
        return { status: "present", at: row.at.toISOString() };
      }
      if (row?.state === "pending" && window === "open") return { status: "pending", at: row.at.toISOString() };
      return { status: window, at: null };
    },

    checkIns(sessionId) {
      return db
        .select()
        .from(attendance)
        .where(eq(attendance.sessionId, sessionId))
        .orderBy(attendance.at)
        .all()
        .map((r) => ({
          rosterEntryId: r.rosterEntryId,
          state: r.state,
          at: r.at.toISOString(),
          ip: r.ip,
          block: r.block,
          deviceId: r.deviceTokenHash?.slice(0, 6) ?? null,
        }));
    },

    nextMoment(after) {
      // A window closes by the midnight after it opened, so only the last two days can matter.
      const open = db
        .select()
        .from(checkInWindow)
        .where(and(isNull(checkInWindow.closedAt), gte(checkInWindow.openedAt, new Date(after.getTime() - 2 * DAY))))
        .all();
      const closes = open.map(midnightOf).filter((m) => m > after);
      return closes.length ? new Date(Math.min(...closes.map((m) => m.getTime()))) : null;
    },
  };
}
