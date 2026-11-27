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
    expect(JSON.stringify(mine)).not.toContain(submissionOf(students[1]!).studentName);
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

// ---- Help -------------------------------------------------------------------------------

const LETTERS = "ABCDEFGH";
const letter = (rosterEntryId: number) => LETTERS[students.indexOf(rosterEntryId)]!;
const student = (l: string) => students[LETTERS.indexOf(l)]!;
const nameOf = (l: string) => submissionOf(student(l)).studentName;
const criterionAt = (n: number) => criteria()[n - 1]!.id;

/** Hands in and reviews on time for each Student ("A": "NSPS" …), then Releases. */
async function released(levels: Record<string, string>) {
  t.fakes.clock.set(BEFORE_DUE);
  await handIn(...Object.keys(levels).map(student));
  t.fakes.clock.set(AFTER_DUE);
  for (const [l, lv] of Object.entries(levels)) review(student(l), lv);
  homework().release(assignmentId);
}

/** "A1" is Student A on Criterion 1. Each one is a minute after the one before. */
function ask(...who: string[]) {
  for (const w of who) {
    t.fakes.clock.advance(60_000);
    homework().requestHelp(assignmentId, criterionAt(Number(w[1])), student(w[0]!));
  }
}
function offer(...who: string[]) {
  for (const w of who) {
    t.fakes.clock.advance(60_000);
    homework().offerHelp(assignmentId, criterionAt(Number(w[1])), student(w[0]!));
  }
}

async function matchNow() {
  homework().matchNow(assignmentId);
  await t.jobs.runDue();
}

/** The matches as "A1<C": Student A's request on Criterion 1 went to Helper C. */
function matches() {
  const position = new Map(criteria().map((c, i) => [c.id, i + 1]));
  return view()
    .help.matches.map((m) => `${letter(m.student.rosterEntryId)}${position.get(m.criterionId)}<${letter(m.helper.rosterEntryId)}`)
    .sort();
}

const helpOf = (l: string, n: number) =>
  homework().studentView(assignmentId, student(l)).help.find((h) => h.criterionId === criterionAt(n))!.state;

describe("Help requests and offers", () => {
  it("are open only after Release", async () => {
    t.fakes.clock.set(BEFORE_DUE);
    await handIn(student("A"));
    t.fakes.clock.set(AFTER_DUE);
    review(student("A"), "NSSS");
    expect(() => ask("A1")).toThrow(DomainError);
    expect(homework().studentView(assignmentId, student("A")).help).toEqual([]);
  });

  it("are taken by level: ask at Not yet or Partly, offer at Secure", async () => {
    await released({ A: "NPSS" });
    expect([1, 2, 3, 4].map((n) => helpOf("A", n).kind)).toEqual(["can-ask", "can-ask", "can-offer", "can-offer"]);
    expect(() => offer("A1")).toThrow(DomainError);
    expect(() => ask("A3")).toThrow(DomainError);
    ask("A1", "A2");
    offer("A3");
    expect([1, 2, 3, 4].map((n) => helpOf("A", n).kind)).toEqual(["asked", "asked", "offered", "can-offer"]);
  });

  it("need a released Review of one's own", async () => {
    await released({ A: "NPSS" });
    await handIn(student("B")); // Late, not reviewed
    expect(() => ask("B1")).toThrow(DomainError);
    expect(homework().studentView(assignmentId, student("B")).help).toEqual([]);
  });

  it("asking twice is the same request", async () => {
    await released({ A: "NPSS" });
    ask("A1", "A1");
    expect(view().help.requests).toHaveLength(1);
  });

  it("show the Lecturer every request and offer, and notify only the Lecturer", async () => {
    await released({ A: "NPSS", B: "SSSS" });
    t.fakes.events.clear();
    ask("A1");
    offer("B1");
    expect(view().help.requests).toEqual([
      expect.objectContaining({ criterionId: criterionAt(1), level: "not-yet", student: expect.objectContaining({ name: nameOf("A") }), helper: null }),
    ]);
    expect(view().help.offers).toEqual([
      expect.objectContaining({ criterionId: criterionAt(1), student: expect.objectContaining({ name: nameOf("B") }), matched: [] }),
    ]);
    expect(t.fakes.events.published.map((p) => p.audience)).toEqual(["lecturer", "lecturer"]);
  });
});

interface MatchCase {
  name: string;
  levels: Record<string, string>;
  asks: string[];
  offers: string[];
  want: string[];
}

describe("Help matching", () => {
  it.each<MatchCase>([
    {
      name: "pairs a request with an offer on the same Criterion",
      levels: { A: "NSSS", B: "SSSS" },
      asks: ["A1"],
      offers: ["B1"],
      want: ["A1<B"],
    },
    {
      name: "never pairs across Criteria",
      levels: { A: "NSSS", B: "SNSS" },
      asks: ["A1"],
      offers: ["A2"],
      want: [],
    },
    {
      name: "matches Not yet before Partly, even when Partly asked first",
      levels: { A: "PSSS", B: "NSSS", C: "SSSS" },
      asks: ["A1", "B1"],
      offers: ["C1"],
      want: ["A1<C", "B1<C"],
    },
    {
      name: "gives a Helper at most 2 per Criterion: Not yet first, then the earliest Partly",
      levels: { A: "PSSS", B: "PSSS", C: "NSSS", D: "SSSS" },
      asks: ["A1", "B1", "C1"],
      offers: ["D1"],
      want: ["A1<D", "C1<D"],
    },
    {
      name: "goes to the earliest asker on a tie",
      levels: { A: "NSSS", B: "NSSS", C: "NSSS", D: "SSSS" },
      asks: ["B1", "C1", "A1"],
      offers: ["D1"],
      want: ["B1<D", "C1<D"],
    },
    {
      name: "spreads requests to the Helper with the fewest matches",
      levels: { A: "NSSS", B: "NSSS", C: "SSSS", D: "SSSS" },
      asks: ["A1", "B1"],
      offers: ["C1", "D1"],
      want: ["A1<C", "B1<D"],
    },
    {
      name: "counts a Helper's matches on other Criteria when choosing the fewest",
      levels: { A: "SNSS", B: "NSSS", C: "SSSS", D: "SSSS" },
      asks: ["A2", "B1"],
      offers: ["C1", "D1", "C2"],
      want: ["A2<C", "B1<D"],
    },
    {
      name: "leaves requests unmatched when the Helpers are full",
      levels: { A: "NSSS", B: "NSSS", C: "NSSS", D: "SSSS" },
      asks: ["A1", "B1", "C1"],
      offers: ["D1"],
      want: ["A1<D", "B1<D"],
    },
  ])("$name", async ({ levels, asks, offers, want }) => {
    await released(levels);
    ask(...asks);
    offer(...offers);
    await matchNow();
    expect(matches()).toEqual(want);
  });

  it("tells each matched Student only the other's name, and never a level", async () => {
    await released({ A: "NSSS", B: "SSSS" });
    ask("A1");
    offer("B1");
    await matchNow();
    expect(helpOf("A", 1)).toEqual({ kind: "paired", with: [nameOf("B")] });
    expect(helpOf("B", 1)).toEqual({ kind: "paired", with: [nameOf("A")] });
    const b = JSON.stringify(homework().studentView(assignmentId, student("B")));
    expect(b).not.toMatch(/not-yet/);
  });

  it("says No Helper this time to an unmatched request and thanks an unmatched offer", async () => {
    await released({ A: "NSSS", B: "SNSS" });
    ask("A1");
    offer("A2");
    await matchNow();
    expect(helpOf("A", 1)).toEqual({ kind: "no-helper" });
    expect(helpOf("A", 2)).toEqual({ kind: "thanks" });
    expect(helpOf("A", 3)).toEqual({ kind: "closed" });
  });

  it("runs when the match deadline passes", async () => {
    await released({ A: "NSSS", B: "SSSS" });
    ask("A1");
    offer("B1");
    await t.jobs.runDue();
    expect(matches()).toEqual([]);
    t.fakes.clock.set("2026-12-10T08:00:00.000Z");
    await t.jobs.runDue();
    expect(matches()).toEqual(["A1<B"]);
    expect(view().state).toBe("matched");
  });

  it("does nothing more a second time: the deadline job after Match now, or Match now again", async () => {
    await released({ A: "NSSS", B: "SSSS", C: "NSSS" });
    ask("A1");
    offer("B1");
    await matchNow();
    const matchedAt = view().matchedAt;
    expect(() => homework().matchNow(assignmentId)).toThrow(DomainError);
    t.fakes.clock.set("2026-12-10T08:00:00.000Z");
    await t.jobs.runDue();
    expect(matches()).toEqual(["A1<B"]);
    expect(view().matchedAt).toBe(matchedAt);
  });

  it("closes requests and offers once matched", async () => {
    await released({ A: "NPSS", B: "SSSS" });
    await matchNow();
    expect(() => ask("A1")).toThrow(DomainError);
    expect(() => offer("B1")).toThrow(DomainError);
    expect(helpOf("A", 1)).toEqual({ kind: "closed" });
  });

  it("is refused before Release", () => {
    expect(() => homework().matchNow(assignmentId)).toThrow(DomainError);
  });

  it("notifies the Lecturer and the Students when it runs", async () => {
    await released({ A: "NSSS", B: "SSSS" });
    t.fakes.events.clear();
    await matchNow();
    expect(t.fakes.events.published).toContainEqual({
      courseId,
      audience: "all",
      notice: { type: "assignment.changed", id: assignmentId },
    });
  });
});

describe("A Late Submission after Release", () => {
  beforeEach(async () => {
    t.fakes.llm.reply("reviewSubmission", (input: { criteria: string[] }) => ({
      criteria: input.criteria.map((_, i) => ({ criterion: i + 1, level: "Not yet", evidence: "", feedback: "Ok." })),
    }));
    t.fakes.llm.reply("classSummary", { commonMistakes: ["Should not be asked again."] });
    await released({ A: "NSSS", B: "SSSS", C: "SSSS", D: "SSSS", E: "SSSS" });
    await handIn(student("F"));
  });

  it("gets its own review run, joins similarity, and leaves the class summary as released", async () => {
    const before = view().classSummary;
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    const v = view();
    expect(submissionOf(student("F")).review).toMatchObject({ status: "drafted", releasedAt: null });
    expect(v.reviewRun).toMatchObject({ done: 1, total: 1, compare: "done", classSummary: null });
    expect(v.classSummary).toEqual(before);
    expect(t.fakes.llm.calls.filter((c) => c.task === "classSummary")).toHaveLength(0);
    expect(v.state).toBe("released");
  });

  it("is seen by its Student only once released on its own", async () => {
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    expect(homework().studentView(assignmentId, student("F")).review).toBeNull();
    t.fakes.events.clear();
    homework().releaseReview(assignmentId, submissionOf(student("F")).id);
    expect(homework().studentView(assignmentId, student("F")).review).not.toBeNull();
    expect(submissionOf(student("F")).review.releasedAt).toBe(t.fakes.clock.now().toISOString());
    expect(t.fakes.events.published.map((p) => p.audience)).toContain("all");
    expect(() => homework().releaseReview(assignmentId, submissionOf(student("F")).id)).toThrow(DomainError);
  });

  it("can ask for help until matching runs, and never changes earlier matches", async () => {
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    homework().releaseReview(assignmentId, submissionOf(student("F")).id);
    ask("F1");
    offer("B1");
    await matchNow();
    expect(matches()).toEqual(["F1<B"]);

    await handIn(student("G"));
    homework().startReviewRun(assignmentId);
    await t.jobs.runDue();
    homework().releaseReview(assignmentId, submissionOf(student("G")).id);
    expect(() => ask("G1")).toThrow(DomainError);
    expect(matches()).toEqual(["F1<B"]);
  });

  it("can't be released on its own before Release or without a Review", async () => {
    expect(() => homework().releaseReview(assignmentId, submissionOf(student("F")).id)).toThrow(DomainError);
  });
});
