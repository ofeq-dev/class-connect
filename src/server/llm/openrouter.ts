import type { Clock } from "../clock";
import type { Db } from "../db";
import { DAILY_LIMIT, DEFAULT_TIMEOUT_MS, type LlmError, type LlmGateway, type LlmResult, type LlmTask } from "./types";
import { createUsage } from "./usage";

const URL = "https://openrouter.ai/api/v1/chat/completions";
const EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
/** One batched embedding call covers a whole Assignment's Submissions. */
const EMBED_TIMEOUT_MS = 60_000;
const PER_MINUTE = 15;

type Message = { role: "user" | "assistant"; content: string };

export interface OpenRouterDeps {
  db: Db;
  clock: Clock;
  apiKey: string;
  /** The fallback list, tried in order. Model ids live in config, not code. */
  models: string[];
  /** The free embedding model for similarity. */
  embeddingModel: string;
  fetch?: typeof fetch;
  /** Waits between requests to keep under the per-minute limit. */
  sleep?: (ms: number) => Promise<void>;
  dailyLimit?: number;
}

class ModelFailure extends Error {
  constructor(
    readonly kind: "timeout" | "failed" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

class DailyLimitReached extends Error {}

/** Pulls the JSON object out of a reply, allowing a Markdown code fence around it. */
export function readJson(content: string): unknown {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end < start) throw new Error("The reply has no JSON object.");
  return JSON.parse(content.slice(start, end + 1));
}

/**
 * The OpenRouter adapter (#2, #4, #10): free models in fallback order, a per-task timeout per
 * request, one schema fix-up retry per model, one call at a time at most ~15 a minute, and every
 * request counted in `llm_usage` against the daily limit. Providers may not keep prompts
 * (`data_collection: "deny"`).
 */
export function createOpenRouterGateway(deps: OpenRouterDeps): LlmGateway {
  const { clock, apiKey, models } = deps;
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dailyLimit = deps.dailyLimit ?? DAILY_LIMIT;
  const usage = createUsage(deps.db, clock);
  const sentAt: number[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  /** Waits for a free slot in the per-minute window, then counts the request. */
  async function takeSlot() {
    for (;;) {
      const now = clock.now().getTime();
      while (sentAt.length && sentAt[0]! <= now - 60_000) sentAt.shift();
      if (sentAt.length < PER_MINUTE) break;
      await sleep(sentAt[0]! + 60_000 - now);
    }
    if (usage.today() >= dailyLimit) throw new DailyLimitReached();
    sentAt.push(clock.now().getTime());
    usage.count();
  }

  async function complete(model: string, messages: Message[], timeoutMs: number): Promise<string> {
    await takeSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    try {
      const res = await doFetch(URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          response_format: { type: "json_object" },
          provider: { data_collection: "deny" },
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new ModelFailure("failed", `${model}: HTTP ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new ModelFailure("failed", `${model}: empty reply`);
      return content;
    } catch (error) {
      if (error instanceof ModelFailure) throw error;
      if (controller.signal.aborted) throw new ModelFailure("timeout", `${model}: timed out after ${timeoutMs} ms`);
      throw new ModelFailure("failed", `${model}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function tryModel<I, O>(model: string, task: LlmTask<I, O>, input: I): Promise<O> {
    const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const prompt: Message = { role: "user", content: task.prompt(input) };
    const content = await complete(model, [prompt], timeoutMs);
    try {
      return task.parse(readJson(content));
    } catch (first) {
      const problem = first instanceof Error ? first.message : String(first);
      const fixUp: Message[] = [
        prompt,
        { role: "assistant", content },
        {
          role: "user",
          content: `That reply doesn't fit the required JSON shape: ${problem}. Reply again with only the corrected JSON object.`,
        },
      ];
      const second = await complete(model, fixUp, timeoutMs);
      try {
        return task.parse(readJson(second));
      } catch (again) {
        throw new ModelFailure("invalid", `${model}: ${again instanceof Error ? again.message : String(again)}`);
      }
    }
  }

  async function run<I, O>(task: LlmTask<I, O>, input: I): Promise<LlmResult<O>> {
    const fail = (kind: LlmError["kind"], message: string): LlmResult<O> => ({ ok: false, error: { kind, message } });
    if (!apiKey) return fail("all-models-failed", "No OpenRouter API key is set.");
    if (usage.today() >= dailyLimit) return fail("daily-limit", dailyLimitMessage(dailyLimit));
    const failures: ModelFailure[] = [];
    for (const model of models) {
      try {
        return { ok: true, value: await tryModel(model, task, input) };
      } catch (error) {
        if (error instanceof DailyLimitReached) return fail("daily-limit", dailyLimitMessage(dailyLimit));
        failures.push(error instanceof ModelFailure ? error : new ModelFailure("failed", String(error)));
      }
    }
    const kind = failures.some((f) => f.kind === "invalid")
      ? "invalid-reply"
      : failures.length > 0 && failures.every((f) => f.kind === "timeout")
        ? "timeout"
        : "all-models-failed";
    return fail(kind, `Every model failed (${failures.map((f) => f.message).join("; ")}).`);
  }

  /** One request for every text's vector, in input order. Rejects on any failure. */
  async function embedAll(texts: string[]): Promise<number[][]> {
    if (!apiKey) throw new Error("No OpenRouter API key is set.");
    if (usage.today() >= dailyLimit) throw new Error(dailyLimitMessage(dailyLimit));
    try {
      await takeSlot();
    } catch (error) {
      if (error instanceof DailyLimitReached) throw new Error(dailyLimitMessage(dailyLimit));
      throw error;
    }
    const model = deps.embeddingModel;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), EMBED_TIMEOUT_MS);
    try {
      const res = await doFetch(EMBEDDINGS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, input: texts, provider: { data_collection: "deny" } }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${model}: HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { index?: unknown; embedding?: unknown }[] };
      const out: number[][] = [];
      for (const [i, item] of (body.data ?? []).entries()) {
        const index = typeof item.index === "number" ? item.index : i;
        if (Array.isArray(item.embedding) && item.embedding.every((x) => typeof x === "number")) {
          out[index] = item.embedding as number[];
        }
      }
      if (out.length !== texts.length || texts.some((_, i) => !out[i])) {
        throw new Error(`${model}: the reply doesn't have one vector per text`);
      }
      return out;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${model}: timed out after ${EMBED_TIMEOUT_MS} ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One call at a time, generate and embed alike. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }

  return {
    generate(task, input) {
      return serial(() => run(task, input));
    },
    embed(texts) {
      if (texts.length === 0) return Promise.resolve([]);
      return serial(() => embedAll(texts));
    },
    usageToday: () => usage.today(),
  };
}

const dailyLimitMessage = (limit: number) =>
  `Today's ${limit} LLM requests are used up. Try again tomorrow.`;
