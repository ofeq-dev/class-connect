import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../errors";
import { aCourse, anAssignmentWithCriteria, aRoster, makeTestApp, type TestApp } from "../testing";

let t: TestApp;
let courseId: number;

// The fake Clock starts on Monday 2026-11-30 in the morning.
const DUE = "2026-12-07T21:59:00.000Z";

const anAssignment = (criteria: string[]) => ({
  title: "Assignment 2",
  instructions: "Write three use cases for the library system.",
  dueAt: DUE,
  criteria,
});

beforeEach(() => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  t.fakes.events.clear();
});
afterEach(() => t.close());

const homework = () => t.modules.homework;

describe("Assignments", () => {
  it("sets an Assignment with 3–5 Criteria, in order", () => {
    const set = homework().setAssignment(courseId, anAssignment(["Actors", "Goals", "Main flow"]));
    expect(set).toMatchObject({
      courseId,
      title: "Assignment 2",
      instructions: "Write three use cases for the library system.",
      dueAt: DUE,
    });
    expect(set.criteria.map((c) => c.label)).toEqual(["Actors", "Goals", "Main flow"]);
    expect(homework().lecturerView(set.id)).toMatchObject({ id: set.id, submissions: [] });
  });

  it.each([
    [["Actors", "Goals"]],
    [["A", "B", "C", "D", "E", "F"]],
    [["Actors", "  ", "Goals"]],
  ])("refuses %j: an Assignment needs 3–5 Criteria", (criteria) => {
    expect(() => homework().setAssignment(courseId, anAssignment(criteria))).toThrow(DomainError);
    expect(homework().forCourse(courseId)).toEqual([]);
  });

  it("refuses an Assignment with no title or a due date that isn't a date", () => {
    const three = ["A", "B", "C"];
    expect(() => homework().setAssignment(courseId, { ...anAssignment(three), title: " " })).toThrow(DomainError);
    expect(() => homework().setAssignment(courseId, { ...anAssignment(three), dueAt: "soon" })).toThrow(DomainError);
  });

  it("edits an Assignment, keeping the Criteria that stay in place", () => {
    const set = homework().setAssignment(courseId, anAssignment(["Actors", "Goals", "Main flow"]));
    const edited = homework().setAssignment(
      courseId,
      { ...anAssignment(["Actors", "Goals and scope", "Main flow", "Alternative flows"]), title: "Assignment 2b" },
      set.id,
    );
    expect(edited.id).toBe(set.id);
    expect(edited.title).toBe("Assignment 2b");
    expect(edited.criteria.map((c) => c.label)).toEqual(["Actors", "Goals and scope", "Main flow", "Alternative flows"]);
    expect(edited.criteria[0]!.id).toBe(set.criteria[0]!.id);
    expect(homework().forCourse(courseId)).toHaveLength(1);
  });

  it("tells the Course's Lecturer and Students that an Assignment changed", () => {
    const set = homework().setAssignment(courseId, anAssignment(["A", "B", "C"]));
    expect(t.fakes.events.published).toEqual([
      { courseId, audience: "all", notice: { type: "assignment.changed", id: set.id } },
    ]);
  });
});

describe("Submissions", () => {
  // Says "A use case names an actor and a goal." on one page.
  const PDF = new Uint8Array(fs.readFileSync(path.resolve(__dirname, "../testing/fixtures/submission.pdf")));
  let assignmentId: number;
  let dana: number;
  let omar: number;

  beforeEach(() => {
    assignmentId = anAssignmentWithCriteria(t, courseId, { dueAt: DUE }).id;
    [dana, omar] = aRoster(t, courseId, 2).map((e) => e.id) as [number, number];
    t.fakes.events.clear();
  });

  it("accepts pasted text and stores it", async () => {
    const mine = await homework().submit(assignmentId, dana, { text: "  Actor: a librarian.  " });
    expect(mine).toMatchObject({ text: "Actor: a librarian.", fileName: null, late: false });
    expect(homework().studentView(assignmentId, dana).submission).toMatchObject({ text: "Actor: a librarian." });
    expect(homework().lecturerView(assignmentId).submissions).toMatchObject([
      { rosterEntryId: dana, studentName: "Dana Levi", studentId: "1001", late: false, fileName: null },
    ]);
  });

  it("accepts a PDF, keeps it in the File store and stores its extracted text", async () => {
    const mine = await homework().submit(assignmentId, dana, { pdf: PDF, fileName: "uc.pdf" });
    expect(mine).toMatchObject({ text: "A use case names an actor and a goal.", fileName: "uc.pdf" });
    expect(await t.fakes.files.get(mine.fileHash!)).toEqual(PDF);
  });

  it("refuses an empty Submission and a file that isn't a readable PDF", async () => {
    await expect(homework().submit(assignmentId, dana, { text: "   " })).rejects.toThrow(DomainError);
    await expect(
      homework().submit(assignmentId, dana, { pdf: new TextEncoder().encode("not a pdf"), fileName: "x.pdf" }),
    ).rejects.toThrow(DomainError);
    expect(homework().studentView(assignmentId, dana).submission).toBeNull();
  });

  it("refuses a PDF over 10 MB", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PDF);
    await expect(homework().submit(assignmentId, dana, { pdf: big, fileName: "big.pdf" })).rejects.toThrow(/10 MB/);
  });

  it("refuses a Student who isn't on the Assignment's Course", async () => {
    const otherCourse = aCourse(t, "Databases").id;
    const stranger = t.modules.course.addRosterEntry(otherCourse, "2001", "Stranger").id;
    await expect(homework().submit(assignmentId, stranger, { text: "Hi" })).rejects.toThrow();
  });

  it("keeps one Submission per Student, replaceable until the due date", async () => {
    await homework().submit(assignmentId, dana, { text: "First go." });
    t.fakes.clock.advance(60_000);
    await homework().submit(assignmentId, dana, { pdf: PDF, fileName: "uc.pdf" });
    await homework().submit(assignmentId, omar, { text: "Omar's go." });

    expect(homework().studentView(assignmentId, dana)).toMatchObject({
      canReplace: true,
      submission: { text: "A use case names an actor and a goal.", fileName: "uc.pdf", late: false },
    });
    expect(homework().lecturerView(assignmentId).submissions.map((s) => s.rosterEntryId)).toEqual([dana, omar]);
    expect(homework().forCourse(courseId)).toMatchObject([{ id: assignmentId, state: "open", submissionCount: 2 }]);
  });

  it("accepts a Submission after the due date as Late, and no longer takes replacements", async () => {
    await homework().submit(assignmentId, dana, { text: "On time." });
    t.fakes.clock.set(DUE);

    const late = await homework().submit(assignmentId, omar, { text: "Sorry, late." });
    expect(late.late).toBe(true);
    await expect(homework().submit(assignmentId, dana, { text: "A better version." })).rejects.toThrow(DomainError);

    expect(homework().studentView(assignmentId, dana)).toMatchObject({ canReplace: false, submission: { text: "On time." } });
    expect(homework().lecturerView(assignmentId)).toMatchObject({
      state: "due",
      submissions: [
        { rosterEntryId: dana, late: false },
        { rosterEntryId: omar, late: true },
      ],
    });
  });

  it("tells the Lecturer, and nobody else, about a Submission", async () => {
    await homework().submit(assignmentId, dana, { text: "Done." });
    expect(t.fakes.events.published).toEqual([
      { courseId, audience: "lecturer", notice: { type: "assignment.changed", id: assignmentId } },
    ]);
  });

  it("lists the Course's Assignments for a Student, with whether they've handed in", async () => {
    await homework().submit(assignmentId, dana, { text: "Done." });
    expect(homework().forStudent(courseId, dana)).toMatchObject([
      { id: assignmentId, title: "Assignment 2", dueAt: DUE, submitted: true, late: false },
    ]);
    expect(homework().forStudent(courseId, omar)).toMatchObject([{ id: assignmentId, submitted: false }]);
  });
});

describe("Drafting Criteria with the LLM", () => {
  const CANNED = { criteria: ["Identifies the actors", "States each goal", "Writes a main flow", "Covers alternatives"] };

  it("proposes Criteria from the title and instructions, for the Lecturer to edit", async () => {
    t.fakes.llm.reply("draftCriteria", CANNED);
    const draft = await homework().draftCriteria({
      title: "Assignment 2",
      instructions: "Write three use cases for the library system.",
    });
    expect(draft).toEqual(CANNED.criteria);
    expect(t.fakes.llm.calls).toEqual([
      {
        task: "draftCriteria",
        input: { title: "Assignment 2", instructions: "Write three use cases for the library system." },
      },
    ]);
    // Nothing is saved: the Lecturer edits the draft and sets the Assignment.
    expect(homework().forCourse(courseId)).toEqual([]);
  });

  it("refuses to draft without instructions, without spending a request", async () => {
    await expect(homework().draftCriteria({ title: "A2", instructions: "  " })).rejects.toThrow(DomainError);
    expect(t.fakes.llm.calls).toEqual([]);
  });

  it("reports a failed request so the Lecturer can try again", async () => {
    t.fakes.llm.fail("draftCriteria", "daily-limit", "The daily limit is reached.");
    await expect(homework().draftCriteria({ title: "A2", instructions: "Do it." })).rejects.toThrow(
      "The daily limit is reached.",
    );
  });
});

describe("The scripted adapter's contract", () => {
  it.each([
    [{ criteria: ["Only", "two"] }],
    [{ criteria: ["A", "B", "C", "D", "E", "F"] }],
    [{ criteria: ["A", "", "C"] }],
    [{ items: ["A", "B", "C"] }],
  ])("holds the draftCriteria reply %j to the task's schema, as the real gateway would", async (reply) => {
    t.fakes.llm.reply("draftCriteria", reply);
    await expect(homework().draftCriteria({ title: "A2", instructions: "Do it." })).rejects.toThrow(DomainError);
  });
});
