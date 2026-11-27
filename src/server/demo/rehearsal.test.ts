import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db";
import { classSummary, draftCriteria, reviewSubmission } from "../homework";
import { draftMarkdown, readTranscript, summarise, translate } from "../summaries";
import { FakeClock } from "../testing";
import { createRehearsalGateway, FIXTURES_DIR, loadRehearsalFixtures } from "./index";

const fixture = (...parts: string[]) => fs.readFileSync(path.join(FIXTURES_DIR, ...parts), "utf8");
/** The summarise input the app sends for an uploaded fixture Transcript. */
function transcriptOf(file: string) {
  const t = readTranscript({ fileName: file, text: fixture("transcripts", file) });
  return { transcript: t.text, hasTimestamps: t.hasTimestamps };
}
const CRITERIA = ["Actors", "Goals", "Main flow", "Alternative flows"];
const reviewInput = (text: string, criteria = CRITERIA) => ({ instructions: "Write use cases.", criteria, text });

let database: OpenedDatabase;
let gateway: ReturnType<typeof createRehearsalGateway>;

beforeEach(async () => {
  database = openDatabase(":memory:", path.resolve(process.cwd(), "drizzle"));
  gateway = createRehearsalGateway({ db: database.db, clock: new FakeClock(), fixtures: await loadRehearsalFixtures() });
});
afterEach(() => database.close());

async function ok<O>(result: Promise<{ ok: true; value: O } | { ok: false; error: { message: string } }>) {
  const r = await result;
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("Loading the rehearsal fixtures", () => {
  it("refuses a fixture file that fails its task's schema, naming the file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fixtures-"));
    fs.cpSync(FIXTURES_DIR, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "llm", "draftCriteria.json"), JSON.stringify({ criteria: ["Only one"] }));
    await expect(loadRehearsalFixtures(dir)).rejects.toThrow(/draftCriteria\.json.*3–5 criteria/);
    fs.rmSync(dir, { recursive: true });
  });
});

describe("summarise", () => {
  it("answers each fixture Transcript with its own canned summary", async () => {
    const clip = transcriptOf("clip-5min.vtt");
    const lecture = transcriptOf("lecture-90min.vtt");
    const a = await ok(gateway.generate(summarise, clip));
    const b = await ok(gateway.generate(summarise, lecture));
    expect(a.overview).toMatch(/sequence diagram/i);
    expect(b.overview).toMatch(/use case/i);
    expect(b.outline.length).toBeGreaterThanOrEqual(5);
    expect(b.outline.every((o) => o.start && lecture.transcript.includes(`[${o.start.padStart(8, "0")}]`))).toBe(true);
  });

  it("builds a generic reply from any other Transcript's first timestamps", async () => {
    const transcript = "[00:00:04] Good morning.\n[00:02:30] Today: testing.\n[00:07:15] Unit tests first.";
    const draft = await ok(gateway.generate(summarise, { transcript, hasTimestamps: true }));
    expect(draft.outline.map((o) => o.start)).toEqual(["00:00:04", "00:02:30", "00:07:15"]);
  });

  it("gives an outline with no times when the Transcript has none", async () => {
    const draft = await ok(gateway.generate(summarise, { transcript: "We talked about testing.", hasTimestamps: false }));
    expect(draft.outline.every((o) => o.start === null)).toBe(true);
  });
});

describe("translate", () => {
  for (const file of ["clip-5min.vtt", "lecture-90min.vtt"]) {
    it(`has canned ar, ru and en translations of the canned summary of ${file}`, async () => {
      const markdown = draftMarkdown(await ok(gateway.generate(summarise, transcriptOf(file))), true);
      const ar = await ok(gateway.generate(translate(markdown), { markdown, language: "ar" }));
      const ru = await ok(gateway.generate(translate(markdown), { markdown, language: "ru" }));
      const en = await ok(gateway.generate(translate(markdown), { markdown, language: "en" }));
      expect(ar.markdown).toMatch(/[؀-ۿ]/);
      expect(ru.markdown).toMatch(/[Ѐ-ӿ]/);
      expect(en.markdown).not.toContain("[en]");
    });
  }

  it("marks each heading with the language for any other input, keeping the timestamps", async () => {
    const markdown = "## Overview\n\nEdited by hand.\n\n## Outline\n\n- `00:01:10` Testing\n";
    const out = await ok(gateway.generate(translate(markdown), { markdown, language: "he" }));
    expect(out.markdown).toBe("## [he] Overview\n\nEdited by hand.\n\n## [he] Outline\n\n- `00:01:10` Testing\n");
  });
});

describe("reviewSubmission", () => {
  it("answers each seeded Submission with its canned Review", async () => {
    const text = fixture("submissions", "01-dana.txt");
    const draft = await ok(gateway.generate(reviewSubmission(4), reviewInput(text)));
    expect(draft.levels.map((l) => l.level)).toEqual(["secure", "secure", "partly", "secure"]);
  });

  it("matches a seeded Submission whatever its whitespace (as text read from a PDF)", async () => {
    const text = fixture("submissions", "05-noa.txt").replace(/\s+/g, "  ");
    const draft = await ok(gateway.generate(reviewSubmission(4), reviewInput(text)));
    expect(draft.levels.map((l) => l.level)).toEqual(["partly", "secure", "secure", "partly"]);
  });

  it("derives the same valid levels from any other Submission's text, for any number of Criteria", async () => {
    const text = "A brand new Submission nobody seeded.";
    const five = [...CRITERIA, "Preconditions"];
    const a = await ok(gateway.generate(reviewSubmission(5), reviewInput(text, five)));
    const b = await ok(gateway.generate(reviewSubmission(5), reviewInput(text, five)));
    const three = await ok(gateway.generate(reviewSubmission(3), reviewInput(text, CRITERIA.slice(0, 3))));
    expect(a.levels).toHaveLength(5);
    expect(b).toEqual(a);
    expect(three.levels).toHaveLength(3);
  });
});

describe("classSummary and draftCriteria", () => {
  it("gives canned common mistakes and four canned Criteria", async () => {
    const summary = await ok(
      gateway.generate(classSummary, { instructions: "", criteria: CRITERIA, reviews: [] }),
    );
    expect(summary.commonMistakes.length).toBeGreaterThan(0);
    const criteria = await ok(gateway.generate(draftCriteria, { title: "Assignment 3", instructions: "Anything." }));
    expect(criteria.criteria).toHaveLength(4);
  });
});

it("still counts every call in llm_usage", async () => {
  await gateway.generate(draftCriteria, { title: "A", instructions: "B" });
  await gateway.generate(draftCriteria, { title: "A", instructions: "B" });
  expect(gateway.usageToday()).toBe(2);
});
