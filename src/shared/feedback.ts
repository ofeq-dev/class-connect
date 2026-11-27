/** Comment statuses and timings, as the Feedback module stores them and both sides read them. */
export const COMMENT_STATUSES = ["new", "pinned", "addressed", "ignored"] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

/** A Comment's place against its Session: before, during or after it. */
export const TIMINGS = ["before", "during", "after"] as const;
export type Timing = (typeof TIMINGS)[number];

/** New and Pinned Comments are open; Addressed and Ignored are dealt with. */
export const isOpen = (status: CommentStatus) => status === "new" || status === "pinned";

/** Open Comments per Topic, most first (ties by name), for the Course desk. Topics with none open are left out. */
export function openByTopic(
  comments: readonly { topicId: number; topicName: string; status: CommentStatus }[],
): { topicId: number; name: string; open: number }[] {
  const byTopic = new Map<number, { topicId: number; name: string; open: number }>();
  for (const c of comments) {
    if (!isOpen(c.status)) continue;
    const row = byTopic.get(c.topicId) ?? { topicId: c.topicId, name: c.topicName, open: 0 };
    row.open++;
    byTopic.set(c.topicId, row);
  }
  return [...byTopic.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
}
