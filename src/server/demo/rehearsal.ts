import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Clock } from "../clock";
import type { Db } from "../db";
import {
  classSummary,
  draftCriteria,
  reviewSubmission,
  type ReviewSubmissionInput,
} from "../homework";
import { createScriptedGateway, type ScriptedGateway } from "../llm";
import { draftMarkdown, readTranscript, summarise, translate, type SummariseInput, type TranslateInput } from "../summaries";

/**
 * The checked-in rehearsal fixtures: two invented Transcripts, the seeded Submissions and one
 * canned-reply file per LLM task. Read from the working directory, like the migrations.
 */
export const FIXTURES_DIR = process.env.FIXTURES_DIR ?? path.resolve(process.cwd(), "fixtures");

/** The canned replies, keyed by the hash of the input they answer. Every one passed its task's schema at load. */
export interface RehearsalFixtures {
  /** Hash of a fixture Transcript's stored text → its summary. */
  summaries: Map<string, unknown>;
  /** Hash of a canned summary's Markdown → its translation per language. */
  translations: Map<string, Record<string, string>>;
  /** Hash of a seeded Submission's text, whitespace collapsed → its Review. */
  reviews: Map<string, unknown>;
  reviewCriteriaCount: number;
  classSummary: unknown;
  draftCriteria: unknown;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** Text read from a PDF breaks lines differently, so Submissions match with whitespace collapsed. */
const submissionKey = (text: string) => sha256(text.replace(/\s+/g, " ").trim());

/**
 * Reads every fixture file and checks each canned reply against its task's schema (the same
 * check the gateway makes on every reply). Rejects naming the file that doesn't fit.
 */
export async function loadRehearsalFixtures(dir = FIXTURES_DIR): Promise<RehearsalFixtures> {
  const read = (...parts: string[]) => readFile(path.join(dir, ...parts), "utf8");
  async function json<T>(file: string, check: (data: T) => void): Promise<T> {
    const data = JSON.parse(await read("llm", file)) as T;
    try {
      check(data);
    } catch (error) {
      throw new Error(`Rehearsal fixture llm/${file}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    return data;
  }

  const summaries = new Map<string, unknown>();
  const sourceMarkdown = new Map<string, string>();
  const summariseFile = await json<{ replies: { transcript: string; reply: unknown }[] }>("summarise.json", (d) => {
    for (const r of d.replies) summarise.parse(r.reply);
  });
  for (const { transcript, reply } of summariseFile.replies) {
    const t = readTranscript({ fileName: transcript, text: await read("transcripts", transcript) });
    summaries.set(sha256(t.text), reply);
    sourceMarkdown.set(transcript, draftMarkdown(summarise.parse(reply), t.hasTimestamps));
  }

  const translations = new Map<string, Record<string, string>>();
  await json<{ translations: ({ transcript: string } & Record<string, string>)[] }>("translate.json", (d) => {
    for (const { transcript, ...byLanguage } of d.translations) {
      const source = sourceMarkdown.get(transcript);
      if (!source) throw new Error(`no canned summary for ${transcript}`);
      for (const [language, markdown] of Object.entries(byLanguage)) {
        try {
          translate(source).parse({ markdown });
        } catch (error) {
          throw new Error(`${transcript} [${language}]: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          });
        }
      }
      translations.set(sha256(source), byLanguage);
    }
  });

  const reviews = new Map<string, unknown>();
  const reviewFile = await json<{ criteriaCount: number; replies: { submission: string; reply: unknown }[] }>(
    "reviewSubmission.json",
    (d) => {
      for (const r of d.replies) reviewSubmission(d.criteriaCount).parse(r.reply);
    },
  );
  for (const { submission, reply } of reviewFile.replies) {
    reviews.set(submissionKey(await read("submissions", submission)), reply);
  }

  return {
    summaries,
    translations,
    reviews,
    reviewCriteriaCount: reviewFile.criteriaCount,
    classSummary: await json<unknown>("classSummary.json", (d) => classSummary.parse(d)),
    draftCriteria: await json<unknown>("draftCriteria.json", (d) => draftCriteria.parse(d)),
  };
}

/** For a Transcript with no canned reply: an outline from its first lines, with their real times. */
function genericSummary({ transcript, hasTimestamps }: SummariseInput) {
  const lines = transcript.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 5);
  const outline = lines.map((line) => {
    const m = /^\[(\d{1,2}:\d{2}:\d{2})\]\s*(.*)$/.exec(line);
    const words = (m ? m[2]! : line).split(/\s+/).slice(0, 8).join(" ") || "Opening";
    return { start: hasTimestamps && m ? m[1]! : null, topic: words };
  });
  return {
    overview: "A rehearsal summary from the fake LLM, built from the first lines of this Transcript.",
    outline,
    keyPoints: outline.map((o) => o.topic),
    reviewQuestions: [
      "What was the Session's main topic?",
      "Which example did the Lecturer work through?",
      "What should you do before the next Session?",
    ],
  };
}

const DERIVED_FEEDBACK = {
  "Not yet": "This Criterion isn't met yet. Look again at the Session's examples and try once more.",
  Partly: "Part of the way there. Compare your answer with the Criterion and fill in what's missing.",
  Secure: "Secure on this Criterion. Keep it up.",
} as const;

/** For a Submission with no canned reply: levels derived from the text's hash, the same every time. */
function derivedReview({ criteria, text }: ReviewSubmissionInput) {
  const hash = createHash("sha256").update(text).digest();
  const words = Object.keys(DERIVED_FEEDBACK) as (keyof typeof DERIVED_FEEDBACK)[];
  const evidence = (text.trim().split(/(?<=[.!?])\s/)[0] ?? "").slice(0, 120);
  return {
    criteria: criteria.map((_, i) => {
      const level = words[hash[i % hash.length]! % 3]!;
      return { criterion: i + 1, level, evidence, feedback: DERIVED_FEEDBACK[level] };
    }),
  };
}

export interface RehearsalGatewayDeps {
  db: Db;
  clock: Clock;
  fixtures: RehearsalFixtures;
  /** FAKE_LLM_DELAY_MS: shows "Summarising…" and review progress in rehearsal. 0 in tests. */
  delayMs?: number;
}

/** Scripts every task's reply onto a scripted gateway: the canned fixture, or the fallback for other input. */
export function scriptRehearsalReplies(gateway: ScriptedGateway, fixtures: RehearsalFixtures): void {
  gateway.reply(
    summarise.name,
    (input: SummariseInput) => fixtures.summaries.get(sha256(input.transcript)) ?? genericSummary(input),
  );
  gateway.reply("translate", ({ markdown, language }: TranslateInput) => ({
    markdown:
      fixtures.translations.get(sha256(markdown))?.[language] ??
      markdown.replace(/^(#{1,6}) /gm, `$1 [${language}] `),
  }));
  gateway.reply("reviewSubmission", (input: ReviewSubmissionInput) =>
    (input.criteria.length === fixtures.reviewCriteriaCount && fixtures.reviews.get(submissionKey(input.text))) ||
    derivedReview(input),
  );
  gateway.reply(classSummary.name, fixtures.classSummary);
  gateway.reply(draftCriteria.name, fixtures.draftCriteria);
}

/**
 * The fake LLM for `LLM_ADAPTER=fake`: the scripted adapter answering every task from the
 * canned fixtures, with the spec's fallback for input it has no canned reply for. It still
 * counts each call in `llm_usage`; `embed` stays the scripted adapter's text-derived vectors.
 */
export function createRehearsalGateway({ db, clock, fixtures, delayMs = 0 }: RehearsalGatewayDeps): ScriptedGateway {
  const gateway = createScriptedGateway({ db, clock, delayMs });
  scriptRehearsalReplies(gateway, fixtures);
  return gateway;
}
