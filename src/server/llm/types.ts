/**
 * A prompt definition, owned by the feature module that uses it (`summarise`, `translate`, …).
 * `parse` is the task's schema: both adapters run every reply through it.
 */
export interface LlmTask<I, O> {
  name: string;
  /** Validates and narrows a reply; throws, saying what is wrong, on a reply that doesn't fit. */
  parse(reply: unknown): O;
  prompt(input: I): string;
  /** How long one request may take before the next model is tried. */
  timeoutMs?: number;
}

export interface LlmError {
  kind: "timeout" | "all-models-failed" | "daily-limit" | "invalid-reply";
  message: string;
}

export type LlmResult<O> = { ok: true; value: O } | { ok: false; error: LlmError };

export interface LlmGateway {
  generate<I, O>(task: LlmTask<I, O>, input: I): Promise<LlmResult<O>>;
  embed(texts: string[]): Promise<number[][]>;
  /** LLM requests sent today, against DAILY_LIMIT. */
  usageToday(): number;
}

export const DAILY_LIMIT = 1000;
export const DEFAULT_TIMEOUT_MS = 60_000;
