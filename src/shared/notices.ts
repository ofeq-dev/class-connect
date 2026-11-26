/**
 * Live events carry "something changed" notices only, never data. The client maps each
 * notice type to the TanStack Query keys it refetches (src/client/live.ts).
 */
export const NOTICE_TYPES = ["course.changed"] as const;

export type NoticeType = (typeof NOTICE_TYPES)[number];

export interface Notice {
  type: NoticeType;
  id: number;
}
