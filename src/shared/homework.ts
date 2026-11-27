/** A Review's level on one Criterion, as stored and as both sides show it. */
export const LEVELS = ["not-yet", "partly", "secure"] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_LABEL: Record<Level, string> = { "not-yet": "Not yet", partly: "Partly", secure: "Secure" };

export const isLevel = (v: unknown): v is Level => (LEVELS as readonly unknown[]).includes(v);
