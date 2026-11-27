import type { LlmTask } from "../llm";
import type { Level } from "./review-task";

export interface ClassSummaryInput {
  instructions: string;
  /** The Criteria labels, in order. */
  criteria: string[];
  /** Anonymised: per Review, each Criterion's level and feedback, in Criteria order. No names, no Submission text. */
  reviews: { level: Level; feedback: string }[][];
}

export interface ClassSummaryDraft {
  commonMistakes: string[];
}

/**
 * The `classSummary` task (#9): the common mistakes across the class's Reviews. The counts per
 * Criterion are worked out in the app, not asked for.
 */
export const classSummary: LlmTask<ClassSummaryInput, ClassSummaryDraft> = {
  name: "classSummary",
  timeoutMs: 2 * 60_000,
  prompt: ({ instructions, criteria, reviews }) =>
    [
      "You help a university Lecturer write an anonymised summary of how a class did on one homework Assignment.",
      "Below are the Criteria and, for each Submission, its level (not-yet, partly, secure) and feedback per Criterion.",
      "List up to 5 common mistakes the class made, each one short sentence a Student can learn from.",
      "Never name or single out a Student. Write in the same language as the feedback.",
      "Reply with only a JSON object of this shape:",
      '{"commonMistakes": [string]}',
      "",
      "Assignment instructions:",
      instructions,
      "",
      "Criteria:",
      ...criteria.map((c, i) => `${i + 1}. ${c}`),
      "",
      "Reviews:",
      ...reviews.map(
        (r, i) => `Submission ${i + 1}: ` + r.map((l, j) => `[${j + 1}] ${l.level}: ${l.feedback}`).join(" "),
      ),
    ].join("\n"),
  parse(reply) {
    if (!reply || typeof reply !== "object") throw new Error("the reply must be a JSON object");
    const list = (reply as Record<string, unknown>).commonMistakes;
    if (!Array.isArray(list)) throw new Error("commonMistakes must be an array");
    if (list.length > 5) throw new Error("there must be at most 5 common mistakes");
    return {
      commonMistakes: list.map((m, i) => {
        if (typeof m !== "string" || !m.trim()) throw new Error(`commonMistakes[${i}] must be a non-empty string`);
        return m.trim();
      }),
    };
  },
};
