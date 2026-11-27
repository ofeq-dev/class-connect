import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../errors";
import { aCourse, anAssignmentWithCriteria, aRoster, makeTestApp, type TestApp } from "../testing";
import { reviewSubmission, type ReviewSubmissionInput } from "./review-task";

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
const callsOf = (task: string) => t.fakes.llm.calls.filter((c) => c.task === task);

async function handIn(texts: string[]) {
  for (const [i, text] of texts.entries()) await homework().submit(assignmentId, students[i]!, { text });
}

/** A new Assignment of the Course with these Submissions, now past its due date. */
async function anAssignmentHandedIn(texts: string[]) {
  t.fakes.clock.set("2026-12-01T08:00:00.000Z");
  assignmentId = anAssignmentWithCriteria(t, courseId, { title: "Assignment 3", dueAt: DUE }).id;
  await handIn(texts);
  t.fakes.clock.set(AFTER_DUE);
}

/** Makes the draft of one Submission's text fail the schema every time. */
function failDraftOf(text: string) {
  t.fakes.llm.reply("reviewSubmission", (input: ReviewSubmissionInput) =>
    input.text === text ? { criteria: [] } : replyAll("Partly")(input),
  );
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

  it("asks the pinned Review model first (the gateway falls back to the shared list after it)", () => {
    expect(reviewSubmission(4).model).toBe("review");
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

describe("A failing draft", () => {
  it("is retried up to 3 times, then shown failed with Retry, and the other Submissions are unaffected", async () => {
    failDraftOf(TEXTS[1]!);
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();

    const draftsOf = (text: string) =>
      t.fakes.llm.calls.filter((c) => c.task === "reviewSubmission" && (c.input as ReviewSubmissionInput).text === text);
    expect(draftsOf(TEXTS[1]!)).toHaveLength(3);
    expect(draftsOf(TEXTS[0]!)).toHaveLength(1);
    const v = view();
    expect(v.submissions.map((s) => s.review.status)).toEqual(["drafted", "failed", "drafted"]);
    expect(v.submissions[1]!.review.error).toMatch(/Criterion 1 is missing/);
    expect(v.reviewRun).toMatchObject({ done: 3, total: 3, failed: 1 });
    expect(v.state).toBe("reviewed");
  });

  it("doesn't stop compare and the class summary, which run on the drafts that succeeded", async () => {
    failDraftOf(TEXTS[1]!);
    const embed = vi.spyOn(t.fakes.llm, "embed");
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();

    expect(view().reviewRun).toMatchObject({ compare: "done", classSummary: "done" });
    expect(callsOf("classSummary")).toHaveLength(1);
    expect(embed).toHaveBeenCalledTimes(1); // one batched call
    expect(embed.mock.calls[0]![0]).toEqual([TEXTS[0], TEXTS[2]]);
    const summary = view().classSummary!;
    expect(summary.reviewCount).toBe(2);
    expect(summary.counts[0]).toMatchObject({ label: "Actors", notYet: 0, partly: 2, secure: 0 });
    expect(summary.commonMistakes).toEqual(["Actors named as systems."]);
  });

  it("runs compare and the class summary again after a successful Retry", async () => {
    failDraftOf(TEXTS[1]!);
    const embed = vi.spyOn(t.fakes.llm, "embed");
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    const failed = view().submissions[1]!;

    t.fakes.llm.reply("reviewSubmission", replyAll("Secure"));
    const retried = homework().retryReview(assignmentId, failed.id);
    expect(retried.submissions[1]!.review.status).toBe("queued");
    expect(retried.state).toBe("reviewing");
    await t.jobs.runDue();

    expect(embed).toHaveBeenCalledTimes(2);
    expect(callsOf("classSummary")).toHaveLength(2);
    const v = view();
    expect(v.reviewRun).toMatchObject({ compare: "done", classSummary: "done" });
    expect(v.submissions[1]!.review.status).toBe("drafted");
    expect(v.classSummary).toMatchObject({ reviewCount: 3 });
    expect(v.classSummary!.counts[0]).toMatchObject({ partly: 2, secure: 1 });
  });

  it("can be written by hand instead, and Retry is then refused", async () => {
    failDraftOf(TEXTS[1]!);
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    const v = view();
    const failed = v.submissions[1]!;
    const levels = v.criteria.map((c) => ({ criterionId: c.id, level: "not-yet" as const, evidence: "", feedback: "Name the actor." }));
    const written = homework().editReview(assignmentId, failed.id, levels).submissions[1]!.review;
    expect(written).toMatchObject({ status: "drafted", author: "lecturer" });
    expect(() => homework().retryReview(assignmentId, failed.id)).toThrow(DomainError);
  });

  it("refuses Retry on a Submission whose draft didn't fail", async () => {
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    expect(() => homework().retryReview(assignmentId, view().submissions[0]!.id)).toThrow(DomainError);
  });
});

// Near-copies: the second is the first with a few words changed and a sentence added.
const ORIGINAL =
  "The main actor in this use case is the librarian, who works at the front desk of the city library. " +
  "Her goal is to lend a book to a registered member. The member hands over the book and a valid library card. " +
  "The librarian scans the card, then scans the barcode of the book, and the system checks that the member has no unpaid fines. " +
  "If everything is in order the system records the loan and prints a slip with the return date three weeks later.";
const NEAR_COPY =
  "The main actor in this use case is the librarian, who works at the front desk of the town library. " +
  "Her goal is to lend a book to a registered member. The member hands over the book and a valid library card. " +
  "The librarian scans the card, then scans the barcode of the book, and the system checks that the member has no unpaid fines. " +
  "When everything is in order the system records the loan and prints a slip with the return date three weeks later. " +
  "This is the most common flow at the desk.";
const UNRELATED = [
  "A member can reserve a title from home using the online catalogue. They search by author or subject, pick an edition " +
    "and press reserve. When a copy is returned by another reader, the system holds it on a shelf behind the counter and " +
    "sends the member an email. The hold lasts five days, after which it passes to the next person in the queue.",
  "Paying a fine is handled by the clerk. The overdue charge is shown on the account screen together with the dates of " +
    "each late item. The clerk takes cash or a card, records the payment, and the member's borrowing rights come back " +
    "straight away. A receipt is offered by email or on paper, and refunds need a manager's approval.",
];

describe("Similar pairs", () => {
  it("pairs near-copies with a score, both signals and the overlapping passages side by side", async () => {
    await anAssignmentHandedIn([ORIGINAL, UNRELATED[0]!, NEAR_COPY, UNRELATED[1]!]);
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();

    const v = view();
    expect(v.similarPairs).toHaveLength(1);
    const pair = v.similarPairs[0]!;
    expect([pair.a.submissionId, pair.b.submissionId]).toEqual([v.submissions[0]!.id, v.submissions[2]!.id]);
    expect(pair.a.studentName).toBe(v.submissions[0]!.studentName);
    expect(pair.fingerprintOverlap).toBeGreaterThan(0.5);
    expect(pair.embeddingSimilarity).toBeGreaterThan(0.9);
    expect(pair.score).toBeGreaterThanOrEqual(0.6);
    expect(pair.passages.length).toBeGreaterThan(0);
    expect(pair.passages.some((p) => p.a.includes("Her goal is to lend a book") && p.b.includes("Her goal is to lend a book"))).toBe(true);
    for (const p of pair.passages) {
      expect(ORIGINAL).toContain(p.a);
      expect(NEAR_COPY).toContain(p.b);
    }
  });

  it("falls back to the fingerprints alone when the embedding call fails 3 times", async () => {
    const embed = vi.spyOn(t.fakes.llm, "embed").mockRejectedValue(new Error("Embedding model down."));
    await anAssignmentHandedIn([ORIGINAL, NEAR_COPY, UNRELATED[0]!]);
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    expect(embed).toHaveBeenCalledTimes(3);
    const v = view();
    expect(v.similarPairs).toHaveLength(1);
    expect(v.similarPairs[0]).toMatchObject({ embeddingSimilarity: null });
    expect(v.similarPairs[0]!.score).toBe(v.similarPairs[0]!.fingerprintOverlap);
    expect(v.reviewRun).toMatchObject({ compare: "done", classSummary: "done" });
  });

  it("doesn't pair unrelated texts", async () => {
    await anAssignmentHandedIn([ORIGINAL, ...UNRELATED, TEXTS[1]!]);
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    expect(view().similarPairs).toEqual([]);
  });

  it("changes no level: the paired Reviews keep their drafts and stay editable", async () => {
    await anAssignmentHandedIn([ORIGINAL, NEAR_COPY, UNRELATED[0]!]);
    t.fakes.llm.reply("reviewSubmission", (input: ReviewSubmissionInput) =>
      replyAll(input.text === ORIGINAL ? "Secure" : "Partly")(input),
    );
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    const v = view();
    expect(v.similarPairs).toHaveLength(1);
    expect(v.submissions[0]!.review.levels.map((l) => l.level)).toEqual(["secure", "secure", "secure", "secure"]);
    expect(v.submissions[1]!.review.levels.map((l) => l.level)).toEqual(["partly", "partly", "partly", "partly"]);
    expect(v.state).toBe("reviewed");
  });

  it("are never in any Student read model", async () => {
    await anAssignmentHandedIn([ORIGINAL, NEAR_COPY, UNRELATED[0]!]);
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    expect(view().similarPairs).toHaveLength(1);

    for (const student of students.slice(0, 3)) {
      const seen = JSON.stringify([homework().studentView(assignmentId, student), homework().forStudent(courseId, student)]);
      expect(seen).not.toMatch(/similar|pair|passage|fingerprint|embedding|score/i);
    }
    // Neither Student of the pair sees the other's text.
    expect(JSON.stringify(homework().studentView(assignmentId, students[0]!))).not.toContain("This is the most common flow");
    expect(JSON.stringify(homework().studentView(assignmentId, students[1]!))).not.toContain("city library");
  });
});

describe("The class summary", () => {
  it("counts levels per Criterion and asks the LLM for common mistakes from anonymised Reviews", async () => {
    t.fakes.llm.reply("reviewSubmission", (input: ReviewSubmissionInput) =>
      replyAll(input.text === TEXTS[0] ? "Not yet" : "Secure")(input),
    );
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();

    const summary = view().classSummary!;
    expect(summary.counts.map((c) => [c.label, c.notYet, c.partly, c.secure])).toEqual([
      ["Actors", 1, 0, 2],
      ["Goals", 1, 0, 2],
      ["Main flow", 1, 0, 2],
      ["Alternative flows", 1, 0, 2],
    ]);
    const call = t.fakes.llm.calls.find((c) => c.task === "classSummary")!;
    const sent = JSON.stringify(call.input);
    expect(sent).not.toContain("Dana");
    expect(sent).not.toContain(TEXTS[0]!);
    expect(call.input).toMatchObject({ criteria: ["Actors", "Goals", "Main flow", "Alternative flows"] });
  });

  it("shows the error once the class summary fails 3 times, keeping the drafts", async () => {
    t.fakes.llm.fail("classSummary", "all-models-failed", "Every model failed.");
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    expect(t.fakes.llm.calls.filter((c) => c.task === "classSummary")).toHaveLength(3);
    const v = view();
    expect(v.reviewRun).toMatchObject({ compare: "done", classSummary: "failed", error: "Every model failed." });
    expect(v.classSummary).toBeNull();
    expect(v.state).toBe("reviewed");
    expect(v.submissions.every((s) => s.review.status === "drafted")).toBe(true);
    expect(t.fakes.events.published.at(-1)!.notice).toEqual({ type: "assignment.changed", id: assignmentId });
  });

  it("tells the Lecturer when compare and the class summary are done", async () => {
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    expect(view().reviewRun).toMatchObject({ compare: "done", classSummary: "done" });
    const last = t.fakes.events.published.at(-1)!;
    expect(last).toEqual({ courseId, audience: "lecturer", notice: { type: "assignment.changed", id: assignmentId } });
  });
});
