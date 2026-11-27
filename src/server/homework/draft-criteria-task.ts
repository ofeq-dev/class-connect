import type { LlmTask } from "../llm";

export interface DraftCriteriaInput {
  title: string;
  instructions: string;
}

export interface CriteriaDraft {
  criteria: string[];
}

/** The `draftCriteria` task (#9): proposes 3–5 Criteria from an Assignment's instructions. */
export const draftCriteria: LlmTask<DraftCriteriaInput, CriteriaDraft> = {
  name: "draftCriteria",
  timeoutMs: 60_000,
  prompt: ({ title, instructions }) =>
    [
      "You help a university Lecturer set homework. From the Assignment below, propose the Criteria",
      "its Submissions will be judged on: 3 to 5 of them, each a single question or skill, short",
      "enough for a table heading (at most about 8 words). Each Submission will reach one of three",
      "levels on every Criterion: Not yet, Partly or Secure, so don't write marks or weights.",
      "Write in the same language as the instructions.",
      "Reply with only a JSON object of this shape:",
      '{"criteria": [string]}',
      "",
      `Assignment title: ${title}`,
      "Instructions:",
      instructions,
    ].join("\n"),
  parse(reply) {
    if (!reply || typeof reply !== "object") throw new Error("the reply must be a JSON object");
    const criteria = (reply as Record<string, unknown>).criteria;
    if (!Array.isArray(criteria)) throw new Error("criteria must be an array");
    if (criteria.length < 3 || criteria.length > 5) throw new Error("there must be 3–5 criteria");
    return {
      criteria: criteria.map((c, i) => {
        if (typeof c !== "string" || !c.trim()) throw new Error(`criteria[${i}] must be a non-empty string`);
        return c.trim();
      }),
    };
  },
};
