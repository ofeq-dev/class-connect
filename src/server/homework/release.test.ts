import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../errors";
import { aCourse, anAssignmentWithCriteria, aRoster, makeTestApp, type TestApp } from "../testing";
import type { Level } from "./review-task";

let t: TestApp;
let courseId: number;
let assignmentId: number;
let students: number[];

// The fake Clock starts on Monday 2026-11-30; the Assignment is due a week later.
const DUE = "2026-12-07T21:59:00.000Z";
const BEFORE_DUE = "2026-12-01T08:00:00.000Z";
const AFTER_DUE = "2026-12-08T08:00:00.000Z";

const L: Record<string, Level> = { N: "not-yet", P: "partly", S: "secure" };

const homework = () => t.modules.homework;
const view = () => homework().lecturerView(assignmentId);
const criteria = () => view().criteria;
const submissionOf = (student: number) => view().submissions.find((s) => s.rosterEntryId === student)!;

/** Hands in a Submission for each Student, at the Clock's current time. */
async function handIn(...who: number[]) {
  for (const s of who) await homework().submit(assignmentId, s, { text: `Work by Student ${s}: use cases.` });
}

/** Writes a Student's Review by hand; levels like "NPSS" give one letter per Criterion. */
function review(student: number, levels: string) {
  homework().editReview(
    assignmentId,
    submissionOf(student).id,
    criteria().map((c, i) => ({ criterionId: c.id, level: L[levels[i]!]!, evidence: "", feedback: `On ${c.label}.` })),
  );
}

beforeEach(async () => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  t.fakes.clock.set(BEFORE_DUE);
  assignmentId = anAssignmentWithCriteria(t, courseId, { dueAt: DUE }).id;
  students = aRoster(t, courseId, 8).map((e) => e.id);
  t.fakes.clock.set(AFTER_DUE);
});
afterEach(() => t.close());

describe("Release", () => {
  beforeEach(async () => {
    t.fakes.clock.set(BEFORE_DUE);
    await handIn(students[0]!, students[1]!);
    t.fakes.clock.set(AFTER_DUE);
  });

  it("is refused, with the reason, while an on-time Submission has no Review", () => {
    review(students[0]!, "NPSS");
    expect(view().releaseBlocker).toMatch(/1 Submission/);
    expect(() => homework().release(assignmentId)).toThrow(DomainError);
    review(students[1]!, "SSSS");
    expect(view().releaseBlocker).toBeNull();
    expect(() => homework().release(assignmentId)).not.toThrow();
  });

  it("is refused before the due date", () => {
    t.fakes.clock.set(BEFORE_DUE);
    expect(view().releaseBlocker).toMatch(/due date/);
    expect(() => homework().release(assignmentId)).toThrow(DomainError);
  });

  it("doesn't wait for a Late Submission's Review", async () => {
    await handIn(students[2]!);
    review(students[0]!, "NPSS");
    review(students[1]!, "SSSS");
    expect(view().releaseBlocker).toBeNull();
  });

  it("happens once, with the match deadline defaulting to two days later", () => {
    review(students[0]!, "NPSS");
    review(students[1]!, "SSSS");
    const released = homework().release(assignmentId);
    expect(released.state).toBe("released");
    expect(released.releasedAt).toBe(AFTER_DUE);
    expect(released.matchDeadline).toBe("2026-12-10T08:00:00.000Z");
    expect(released.submissions.every((s) => s.review.releasedAt === AFTER_DUE)).toBe(true);
    expect(() => homework().release(assignmentId)).toThrow(DomainError);
  });

  it("takes a match deadline, which must be in the future", () => {
    review(students[0]!, "NPSS");
    review(students[1]!, "SSSS");
    expect(() => homework().release(assignmentId, "2026-12-08T07:00:00.000Z")).toThrow(DomainError);
    expect(homework().release(assignmentId, "2026-12-09T12:00:00.000Z").matchDeadline).toBe(
      "2026-12-09T12:00:00.000Z",
    );
  });

  it("shows Students nothing before, then their own Review and nobody else's", () => {
    review(students[0]!, "NPSS");
    review(students[1]!, "SSSS");
    expect(homework().studentView(assignmentId, students[0]!).review).toBeNull();
    homework().release(assignmentId);
    const mine = homework().studentView(assignmentId, students[0]!);
    expect(mine.state).toBe("released");
    expect(mine.review!.levels.map((l) => l.level)).toEqual(["not-yet", "partly", "secure", "secure"]);
    expect(mine.review!.levels[0]).toMatchObject({ label: "Actors", feedback: "On Actors." });
    expect(JSON.stringify(mine)).not.toContain("Student 2");
  });

  it("notifies the Lecturer and the Students", () => {
    review(students[0]!, "NPSS");
    review(students[1]!, "SSSS");
    t.fakes.events.clear();
    homework().release(assignmentId);
    expect(t.fakes.events.published).toContainEqual({
      courseId,
      audience: "all",
      notice: { type: "assignment.changed", id: assignmentId },
    });
  });

  it("freezes the Assignment's Criteria", () => {
    review(students[0]!, "NPSS");
    review(students[1]!, "SSSS");
    homework().release(assignmentId);
    const a = view();
    expect(() =>
      homework().setAssignment(courseId, { ...a, criteria: ["One", "Two", "Three"] }, assignmentId),
    ).toThrow(DomainError);
  });
});

describe("The released class summary", () => {
  it("counts the released Reviews per Criterion, keeping the run's common mistakes", async () => {
    t.fakes.clock.set(BEFORE_DUE);
    await handIn(...students.slice(0, 5));
    t.fakes.clock.set(AFTER_DUE);
    t.fakes.llm.reply("reviewSubmission", (input: { criteria: string[] }) => ({
      criteria: input.criteria.map((_, i) => ({ criterion: i + 1, level: "Partly", evidence: "", feedback: "Ok." })),
    }));
    t.fakes.llm.reply("classSummary", { commonMistakes: ["Actors named as systems."] });
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    review(students[0]!, "SPPP"); // edited after the run: the released counts follow it

    homework().release(assignmentId);
    const summary = homework().studentView(assignmentId, students[1]!).classSummary!;
    expect(summary.counts[0]).toEqual({ criterionId: criteria()[0]!.id, label: "Actors", notYet: 0, partly: 4, secure: 1 });
    expect(summary.commonMistakes).toEqual(["Actors named as systems."]);
    expect(JSON.stringify(summary)).not.toMatch(/Student|Work by/);
  });

  it("is hidden from Students below 5 Submissions", async () => {
    t.fakes.clock.set(BEFORE_DUE);
    await handIn(...students.slice(0, 4));
    t.fakes.clock.set(AFTER_DUE);
    for (const s of students.slice(0, 4)) review(s, "PPPP");
    homework().release(assignmentId);
    const mine = homework().studentView(assignmentId, students[0]!);
    expect(mine.classSummary).toBeNull();
    expect(mine.classSummaryHidden).toBe(true);
    expect(view().classSummary).toMatchObject({ reviewCount: 4 });
  });
});
