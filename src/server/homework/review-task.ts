import type { LlmTask } from "../llm";

export type Level = "not-yet" | "partly" | "secure";
export const LEVELS: readonly Level[] = ["not-yet", "partly", "secure"];

export interface ReviewSubmissionInput {
  instructions: string;
  /** The Criteria labels, in order. */
  criteria: string[];
  text: string;
}

export interface DraftLevel {
  level: Level;
  evidence: string;
  feedback: string;
}

/** One entry per Criterion, in the Criteria's order. */
export interface ReviewDraft {
  levels: DraftLevel[];
}

const LEVEL_WORDS: Record<string, Level> = { "not yet": "not-yet", partly: "partly", secure: "secure" };

/**
 * The `reviewSubmission` task (#9): drafts a Review of one Submission, a level, an evidence quote
 * and feedback for every Criterion. There is no overall mark. The parser needs the Criteria
 * count, so the task is made per Assignment.
 */
export function reviewSubmission(criteriaCount: number): LlmTask<ReviewSubmissionInput, ReviewDraft> {
  return {
    name: "reviewSubmission",
    model: "review",
    timeoutMs: 2 * 60_000,
    prompt: ({ instructions, criteria, text }) =>
      [
        "You help a university Lecturer review one Student's homework Submission against the Criteria below.",
        "For every Criterion give:",
        '- level: exactly one of "Not yet", "Partly" or "Secure";',
        "- evidence: a short quote copied word for word from the Submission that supports the level",
        '  (an empty string if the Submission says nothing on it);',
        "- feedback: one or two sentences to the Student on what to keep or improve.",
        "Don't give an overall mark. Write the feedback in the same language as the Submission.",
        "Reply with only a JSON object of this shape, one entry per Criterion, numbered from 1:",
        '{"criteria": [{"criterion": number, "level": string, "evidence": string, "feedback": string}]}',
        "",
        "Assignment instructions:",
        instructions,
        "",
        "Criteria:",
        ...criteria.map((c, i) => `${i + 1}. ${c}`),
        "",
        "Submission:",
        text,
      ].join("\n"),
    parse(reply) {
      if (!reply || typeof reply !== "object") throw new Error("the reply must be a JSON object");
      const items = (reply as Record<string, unknown>).criteria;
      if (!Array.isArray(items)) throw new Error("criteria must be an array");
      const levels: (DraftLevel | undefined)[] = new Array<DraftLevel | undefined>(criteriaCount).fill(undefined);
      items.forEach((item, i) => {
        const o = (item ?? {}) as Record<string, unknown>;
        const n = o.criterion;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > criteriaCount) {
          throw new Error(`criteria[${i}].criterion must be a number from 1 to ${criteriaCount}`);
        }
        if (levels[n - 1]) throw new Error(`Criterion ${n} appears twice`);
        const level = typeof o.level === "string" ? LEVEL_WORDS[o.level.trim().toLowerCase()] : undefined;
        if (!level) throw new Error(`criteria[${i}].level must be "Not yet", "Partly" or "Secure"`);
        if (typeof o.evidence !== "string") throw new Error(`criteria[${i}].evidence must be a string`);
        if (typeof o.feedback !== "string" || !o.feedback.trim()) {
          throw new Error(`criteria[${i}].feedback must be a non-empty string`);
        }
        levels[n - 1] = { level, evidence: o.evidence.trim(), feedback: o.feedback.trim() };
      });
      const missing = levels.findIndex((l) => !l);
      if (missing !== -1) throw new Error(`Criterion ${missing + 1} is missing`);
      return { levels: levels as DraftLevel[] };
    },
  };
}
