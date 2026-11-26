import type { LlmTask } from "../llm";

export interface SummariseInput {
  transcript: string;
  hasTimestamps: boolean;
}

export interface SummaryDraft {
  overview: string;
  outline: { start: string | null; topic: string }[];
  keyPoints: string[];
  reviewQuestions: string[];
}

const START = /^\d{1,2}:\d{2}(:\d{2})?$/;

function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${what} must be a non-empty string`);
  return value.trim();
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${what} must be a non-empty array`);
  return value;
}

/** The `summarise` task (#8): one request turns a Transcript into a draft Session summary. */
export const summarise: LlmTask<SummariseInput, SummaryDraft> = {
  name: "summarise",
  timeoutMs: 3 * 60_000,
  prompt: ({ transcript, hasTimestamps }) =>
    [
      "You summarise a university class Session for its Students from the Transcript below.",
      "Write in the same language as the Transcript.",
      "Reply with only a JSON object of this shape:",
      '{"overview": string, "outline": [{"start": string | null, "topic": string}], "keyPoints": [string], "reviewQuestions": [string]}',
      "- overview: one short paragraph on what the Session covered.",
      hasTimestamps
        ? '- outline: the topics in order; "start" is the hh:mm:ss timestamp in the Transcript where each topic starts.'
        : '- outline: the topics in order; the Transcript has no timestamps, so "start" is null.',
      "- keyPoints: the main points a Student should remember.",
      "- reviewQuestions: 3 to 5 questions a Student can answer to check their understanding.",
      "",
      "Transcript:",
      transcript,
    ].join("\n"),
  parse(reply) {
    if (!reply || typeof reply !== "object") throw new Error("the reply must be a JSON object");
    const r = reply as Record<string, unknown>;
    const outline = list(r.outline, "outline").map((item, i) => {
      const o = (item ?? {}) as Record<string, unknown>;
      const start = o.start === null || o.start === undefined || o.start === "" ? null : o.start;
      if (start !== null && (typeof start !== "string" || !START.test(start))) {
        throw new Error(`outline[${i}].start must be a hh:mm:ss timestamp or null`);
      }
      return { start, topic: text(o.topic, `outline[${i}].topic`) };
    });
    const reviewQuestions = list(r.reviewQuestions, "reviewQuestions").map((q, i) => text(q, `reviewQuestions[${i}]`));
    if (reviewQuestions.length < 3 || reviewQuestions.length > 5) {
      throw new Error("there must be 3–5 review questions");
    }
    return {
      overview: text(r.overview, "overview"),
      outline,
      keyPoints: list(r.keyPoints, "keyPoints").map((k, i) => text(k, `keyPoints[${i}]`)),
      reviewQuestions,
    };
  },
};

/** The draft as Markdown, the form the Lecturer edits. Times only when the Transcript had them. */
export function draftMarkdown(draft: SummaryDraft, withTimes: boolean): string {
  const outline = draft.outline.map((o) =>
    withTimes && o.start ? `- \`${o.start}\` ${o.topic}` : `- ${o.topic}`,
  );
  return [
    "## Overview",
    "",
    draft.overview,
    "",
    "## Outline",
    "",
    ...outline,
    "",
    "## Key points",
    "",
    ...draft.keyPoints.map((k) => `- ${k}`),
    "",
    "## Review questions",
    "",
    ...draft.reviewQuestions.map((q, i) => `${i + 1}. ${q}`),
    "",
  ].join("\n");
}
