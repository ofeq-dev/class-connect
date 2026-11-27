import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

const env = { LECTURER_PASSWORD_HASH: "hash", COOKIE_SECRET: "secret" };

describe("Config", () => {
  it("pins the structured-output Review model apart from the fallback list, overridable by LLM_REVIEW_MODEL", () => {
    const config = loadConfig(env);
    expect(config.llm.reviewModel).toBe("nvidia/nemotron-3.5-super-vl:free");
    expect(config.llm.models).not.toContain("nvidia/nemotron-3.5-super-vl:free");
    expect(loadConfig({ ...env, LLM_REVIEW_MODEL: "other/model:free" }).llm.reviewModel).toBe("other/model:free");
  });
});
