/**
 * Live events carry "something changed" notices only, never data. The client maps each
 * notice type to the TanStack Query keys it refetches (src/client/live.ts).
 *
 * The id is the changed thing's id: a Course for course.changed and roster.changed,
 * a Session for session.changed and summary.changed, an Assignment for assignment.changed and
 * job.progress. job.progress, the Lecturer's review-run progress, also carries the counts
 * `{done, total}` so a progress bar can move without a refetch.
 */
export const NOTICE_TYPES = [
  "course.changed",
  "roster.changed",
  "session.changed",
  "summary.changed",
  "assignment.changed",
  "job.progress",
] as const;

export type NoticeType = (typeof NOTICE_TYPES)[number];

export interface Notice {
  type: NoticeType;
  id: number;
  progress?: { done: number; total: number };
}
