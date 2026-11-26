/**
 * LLM gateway seam (docs/diagrams/class-diagram.md). Only the interface exists so far;
 * the OpenRouter and scripted adapters arrive with the Session summary work (#32).
 */
export interface LlmTask<I, O> {
  name: string;
  /** Validates and narrows a reply; throws on a reply that doesn't fit. */
  parse(reply: unknown): O;
  prompt(input: I): string;
}

export interface LlmError {
  kind: "timeout" | "all-models-failed" | "daily-limit" | "invalid-reply";
  message: string;
}

export type LlmResult<O> = { ok: true; value: O } | { ok: false; error: LlmError };

export interface LlmGateway {
  generate<I, O>(task: LlmTask<I, O>, input: I): Promise<LlmResult<O>>;
  embed(texts: string[]): Promise<number[][]>;
  usageToday(): number;
}
