/**
 * Live events carry "something changed" notices only, never data. The client maps each
 * notice type to the TanStack Query keys it refetches (src/client/live.ts).
 *
 * The id is the changed thing's id: a Course for course.changed and roster.changed,
 * a Session for session.changed, summary.changed and attendance.changed.
 */
export const NOTICE_TYPES = [
  "course.changed",
  "roster.changed",
  "session.changed",
  "summary.changed",
  "attendance.changed",
] as const;

export type NoticeType = (typeof NOTICE_TYPES)[number];

export interface Notice {
  type: NoticeType;
  id: number;
}
