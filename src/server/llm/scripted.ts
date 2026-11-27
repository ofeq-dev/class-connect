import type { Clock } from "../clock";
import type { Db } from "../db";
import type { LlmError, LlmGateway, LlmResult, LlmTask } from "./types";
import { createUsage } from "./usage";

type Script = { reply: unknown } | { error: LlmError };

export interface ScriptedGateway extends LlmGateway {
  /** Every later call of the task gets this reply, or the reply this function makes from the input. */
  reply<I>(taskName: string, reply: unknown | ((input: I) => unknown)): void;
  /** Every later call of the task gets this LlmError. */
  fail(taskName: string, kind: LlmError["kind"], message?: string): void;
  /** Every call made, in order. */
  readonly calls: { task: string; input: unknown }[];
}

export interface ScriptedDeps {
  db: Db;
  clock: Clock;
  /** Delays each reply, so "Summarising…" is visible in rehearsal. 0 in tests. */
  delayMs?: number;
}

/**
 * The scripted adapter, used by tests and by `LLM_ADAPTER=fake`. Scripted replies go through the
 * task's own `parse`, so a test can't hand a module a shape the real gateway would reject.
 * It still counts each call in `llm_usage`. Rehearsal's canned replies are scripted onto it by
 * `createRehearsalGateway` (demo module).
 */
export function createScriptedGateway({ db, clock, delayMs = 0 }: ScriptedDeps): ScriptedGateway {
  const scripts = new Map<string, Script>();
  const usage = createUsage(db, clock);
  const calls: { task: string; input: unknown }[] = [];

  return {
    calls,
    reply(taskName, reply) {
      scripts.set(taskName, { reply });
    },
    fail(taskName, kind, message = `Scripted ${kind}.`) {
      scripts.set(taskName, { error: { kind, message } });
    },
    async generate<I, O>(task: LlmTask<I, O>, input: I): Promise<LlmResult<O>> {
      calls.push({ task: task.name, input });
      usage.count();
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const script = scripts.get(task.name);
      if (!script) {
        return { ok: false, error: { kind: "all-models-failed", message: `No scripted reply for ${task.name}.` } };
      }
      if ("error" in script) return { ok: false, error: script.error };
      const raw = typeof script.reply === "function" ? (script.reply as (i: I) => unknown)(input) : script.reply;
      try {
        return { ok: true, value: task.parse(raw) };
      } catch (error) {
        return {
          ok: false,
          error: { kind: "invalid-reply", message: error instanceof Error ? error.message : String(error) },
        };
      }
    },
    embed(texts) {
      return Promise.resolve(texts.map(textVector));
    },
    usageToday: () => usage.today(),
  };
}

/** A deterministic vector from character trigrams: the same or nearly the same text gives similar vectors. */
function textVector(text: string): number[] {
  const v = new Array<number>(64).fill(0);
  const t = text.toLowerCase();
  for (let i = 0; i + 3 <= t.length; i++) {
    let h = 0;
    for (let j = i; j < i + 3; j++) h = (h * 31 + t.charCodeAt(j)) >>> 0;
    v[h % 64]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
