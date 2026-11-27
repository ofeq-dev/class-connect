/** One-tap quick reactions a Student can send as a Comment. The key is stored; the label is the text. */
export const REACTIONS = [
  { key: "too-fast", label: "Too fast" },
  { key: "repeat", label: "Can you repeat that?" },
  { key: "lost", label: "I'm lost" },
  { key: "cant-hear", label: "Can't hear you" },
] as const;

export type ReactionKey = (typeof REACTIONS)[number]["key"];

export const reactionLabel = (key: string): string | null => REACTIONS.find((r) => r.key === key)?.label ?? null;
