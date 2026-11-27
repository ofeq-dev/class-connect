import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../errors";
import { aCourse, anAssignmentWithCriteria, aRoster, makeTestApp, type TestApp } from "../testing";
import type { ReviewSubmissionInput } from "./review-task";

let t: TestApp;
let courseId: number;
let assignmentId: number;
let students: number[];

// The fake Clock starts on Monday 2026-11-30; the Assignment is due a week later.
const DUE = "2026-12-07T21:59:00.000Z";
const AFTER_DUE = "2026-12-08T08:00:00.000Z";

const TEXTS = [
  "The librarian is the primary actor. Her goal is to lend a book to a member who shows a valid card.",
  "A member reserves a title online; the system emails them when a copy comes back to the shelf.",
  "Use case: pay a fine. The member pays at the desk and the clerk records the payment in the ledger.",
];

/** A reviewSubmission reply giving every Criterion the same level. */
const replyAll = (level: string) => (input: ReviewSubmissionInput) => ({
  criteria: input.criteria.map((_, i) => ({
    criterion: i + 1,
    level,
    evidence: input.text.split(".")[0],
    feedback: `Feedback on Criterion ${i + 1}.`,
  })),
});

const homework = () => t.modules.homework;
const view = () => homework().lecturerView(assignmentId);
const jobsOf = (kind: string) =>
  t.database.sqlite.prepare("select id, status from job where kind = ? order by id").all(kind) as {
    id: number;
    status: string;
  }[];

async function handIn(texts: string[]) {
  for (const [i, text] of texts.entries()) await homework().submit(assignmentId, students[i]!, { text });
}

beforeEach(async () => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  assignmentId = anAssignmentWithCriteria(t, courseId, { dueAt: DUE }).id;
  students = aRoster(t, courseId, 6).map((e) => e.id);
  await handIn(TEXTS);
  t.fakes.clock.set(AFTER_DUE);
  t.fakes.llm.reply("reviewSubmission", replyAll("Partly"));
  t.fakes.llm.reply("classSummary", { commonMistakes: ["Actors named as systems."] });
  t.fakes.events.clear();
});
afterEach(() => t.close());

describe("Starting a review run", () => {
  it("queues one review.submission job per Submission and shows 0 of 3", () => {
    const started = homework().startReviewRun(assignmentId);
    expect(jobsOf("review.submission")).toHaveLength(3);
    expect(started.state).toBe("reviewing");
    expect(started.reviewRun).toMatchObject({ done: 0, total: 3, failed: 0 });
    expect(started.submissions.map((s) => s.review.status)).toEqual(["queued", "queued", "queued"]);
  });

  it("is refused before the due date, and while a run is going", () => {
    t.fakes.clock.set("2026-12-01T08:00:00.000Z");
    expect(() => homework().startReviewRun(assignmentId)).toThrow(DomainError);
    t.fakes.clock.set(AFTER_DUE);
    homework().startReviewRun(assignmentId);
    expect(() => homework().startReviewRun(assignmentId)).toThrow(DomainError);
  });

  it("publishes job.progress to the Lecturer as each draft settles", async () => {
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    const progress = t.fakes.events.published.filter((p) => p.notice.type === "job.progress");
    expect(progress.map((p) => p.notice.progress)).toEqual([
      { done: 0, total: 3 },
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ]);
    expect(progress.every((p) => p.audience === "lecturer" && p.notice.id === assignmentId)).toBe(true);
  });
});

describe("Draft Reviews", () => {
  it("drafts a level, an evidence quote and feedback per Criterion, with no overall mark", async () => {
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    const v = view();
    expect(v.state).toBe("reviewed");
    expect(v.reviewRun).toMatchObject({ done: 3, total: 3, failed: 0 });
    const first = v.submissions[0]!.review;
    expect(first.status).toBe("drafted");
    expect(first.author).toBe("ai");
    expect(first.levels).toHaveLength(4);
    expect(first.levels[0]).toEqual({
      criterionId: v.criteria[0]!.id,
      level: "partly",
      evidence: "The librarian is the primary actor",
      feedback: "Feedback on Criterion 1.",
    });
    expect(first).not.toHaveProperty("mark");
    const call = t.fakes.llm.calls.find((c) => c.task === "reviewSubmission")!;
    expect(call.input).toMatchObject({
      criteria: ["Actors", "Goals", "Main flow", "Alternative flows"],
      text: TEXTS[0],
    });
  });

  it("lets the Lecturer edit any draft Review", async () => {
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    const v = view();
    const submissionId = v.submissions[1]!.id;
    const levels = v.criteria.map((c) => ({
      criterionId: c.id,
      level: "secure" as const,
      evidence: "reserves a title online",
      feedback: "Clear and complete.",
    }));
    const edited = homework().editReview(assignmentId, submissionId, levels);
    const review = edited.submissions[1]!.review;
    expect(review.levels.map((l) => l.level)).toEqual(["secure", "secure", "secure", "secure"]);
    expect(review.author).toBe("ai");
    expect(review.editedAt).toBe(new Date(AFTER_DUE).toISOString());
  });

  it("refuses an edit that misses a Criterion or has an unknown level", async () => {
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    const v = view();
    const submissionId = v.submissions[0]!.id;
    const full = v.criteria.map((c) => ({ criterionId: c.id, level: "secure" as const, evidence: "", feedback: "Good." }));
    expect(() => homework().editReview(assignmentId, submissionId, full.slice(1))).toThrow(DomainError);
    expect(() =>
      homework().editReview(assignmentId, submissionId, [
        ...full.slice(1),
        { ...full[0]!, level: "excellent" as never },
      ]),
    ).toThrow(DomainError);
    expect(() =>
      homework().editReview(assignmentId, submissionId, [...full.slice(1), { ...full[0]!, feedback: " " }]),
    ).toThrow(DomainError);
  });
});
