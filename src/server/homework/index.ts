import { and, asc, eq, inArray } from "drizzle-orm";
import type { Clock } from "../clock";
import type { CourseModule } from "../course";
import type { Db } from "../db";
import { DomainError, NotFoundError } from "../errors";
import type { FileStore } from "../files";
import type { LiveEvents } from "../live-events";
import type { LlmGateway } from "../llm";
import { draftCriteria as draftCriteriaTask } from "./draft-criteria-task";
import { pdfText } from "./pdf";
import { assignment as assignmentTable, criterion, submission as submissionTable } from "./schema";

export const MIN_CRITERIA = 3;
export const MAX_CRITERIA = 5;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export interface AssignmentInput {
  title: string;
  instructions: string;
  /** An instant (ISO 8601). */
  dueAt: string;
  /** The Criteria labels, in order; blank ones are ignored. */
  criteria: string[];
}

export interface Criterion {
  id: number;
  label: string;
}

export interface Assignment {
  id: number;
  courseId: number;
  title: string;
  instructions: string;
  dueAt: string;
  criteria: Criterion[];
}

/** open until the due date, due after it. Review-run states come with the review run. */
export type AssignmentState = "open" | "due";

export interface LecturerSubmission {
  id: number;
  rosterEntryId: number;
  studentName: string;
  studentId: string;
  submittedAt: string;
  late: boolean;
  fileName: string | null;
}

export interface LecturerAssignment extends Assignment {
  state: AssignmentState;
  /** Oldest first. */
  submissions: LecturerSubmission[];
}

export interface AssignmentRow {
  id: number;
  title: string;
  dueAt: string;
  state: AssignmentState;
  submissionCount: number;
}

/** Pasted text, or a PDF whose text is extracted in the app. */
export type SubmissionInput = { text: string } | { pdf: Uint8Array; fileName: string };

export interface StudentSubmission {
  text: string;
  /** The PDF in the File store; null for pasted text. */
  fileHash: string | null;
  fileName: string | null;
  submittedAt: string;
  late: boolean;
}

export interface StudentAssignment extends Assignment {
  state: AssignmentState;
  submission: StudentSubmission | null;
  /** Until the due date a Student can hand in or replace; after it only a first, Late, Submission. */
  canReplace: boolean;
}

export interface StudentAssignmentRow {
  id: number;
  title: string;
  dueAt: string;
  state: AssignmentState;
  submitted: boolean;
  late: boolean;
}

export interface HomeworkModule {
  /** Creates an Assignment, or edits the given one. 3–5 Criteria, else refused. */
  setAssignment(courseId: number, input: AssignmentInput, assignmentId?: number): LecturerAssignment;
  /** Asks the LLM to propose 3–5 Criteria from the instructions, for the Lecturer to edit. Saves nothing. */
  draftCriteria(input: { title: string; instructions: string }): Promise<string[]>;
  lecturerView(assignmentId: number): LecturerAssignment;
  /** One row per Assignment of the Course, by due date, for the Course desk. */
  forCourse(courseId: number): AssignmentRow[];
  /**
   * A Student's one Submission, replaceable until the due date. After it a first Submission is
   * still accepted and reads as Late; a replacement is refused.
   */
  submit(assignmentId: number, rosterEntryId: number, input: SubmissionInput): Promise<StudentSubmission>;
  studentView(assignmentId: number, rosterEntryId: number): StudentAssignment;
  /** The Course's Assignments for the Student app's Today list, by due date. */
  forStudent(courseId: number, rosterEntryId: number): StudentAssignmentRow[];
}

export interface HomeworkDeps {
  db: Db;
  clock: Clock;
  course: CourseModule;
  llm: LlmGateway;
  files: FileStore;
  events: LiveEvents;
}

export function createHomeworkModule({ db, clock, course, llm, files, events }: HomeworkDeps): HomeworkModule {
  const changed = (courseId: number, assignmentId: number, audience: "all" | "lecturer" = "all") =>
    events.publish(courseId, audience, { type: "assignment.changed", id: assignmentId });

  const stateOf = (dueAt: Date): AssignmentState => (clock.now() < dueAt ? "open" : "due");

  function assignmentRow(assignmentId: number) {
    const row = db.select().from(assignmentTable).where(eq(assignmentTable.id, assignmentId)).get();
    if (!row) throw new NotFoundError("Assignment");
    return row;
  }

  function criteriaOf(assignmentId: number): Criterion[] {
    return db
      .select({ id: criterion.id, label: criterion.label })
      .from(criterion)
      .where(eq(criterion.assignmentId, assignmentId))
      .orderBy(asc(criterion.position))
      .all();
  }

  function toAssignment(row: typeof assignmentTable.$inferSelect): Assignment {
    return {
      id: row.id,
      courseId: row.courseId,
      title: row.title,
      instructions: row.instructions,
      dueAt: row.dueAt.toISOString(),
      criteria: criteriaOf(row.id),
    };
  }

  function read(input: AssignmentInput) {
    const title = input.title.trim();
    if (!title) throw new DomainError("assignment.no-title", "Give the Assignment a title.");
    const dueAt = new Date(input.dueAt);
    if (!input.dueAt || Number.isNaN(dueAt.getTime())) {
      throw new DomainError("assignment.bad-due-date", "Give the Assignment a due date.");
    }
    const labels = input.criteria.map((c) => c.trim()).filter(Boolean);
    if (labels.length < MIN_CRITERIA || labels.length > MAX_CRITERIA) {
      throw new DomainError(
        "assignment.criteria-count",
        `An Assignment needs ${MIN_CRITERIA}–${MAX_CRITERIA} Criteria; this has ${labels.length}.`,
      );
    }
    return { title, instructions: input.instructions.trim(), dueAt, labels };
  }

  /** The Roster entry, which must be on the Assignment's Course. */
  function studentOn(courseId: number, rosterEntryId: number) {
    const entry = course.listRoster(courseId).find((e) => e.id === rosterEntryId);
    if (!entry) throw new NotFoundError("Student");
    return entry;
  }

  const submissionRow = (assignmentId: number, rosterEntryId: number) =>
    db
      .select()
      .from(submissionTable)
      .where(and(eq(submissionTable.assignmentId, assignmentId), eq(submissionTable.rosterEntryId, rosterEntryId)))
      .get();

  const toStudentSubmission = (
    s: typeof submissionTable.$inferSelect,
    dueAt: Date,
  ): StudentSubmission => ({
    text: s.text,
    fileHash: s.fileHash,
    fileName: s.fileName,
    submittedAt: s.submittedAt.toISOString(),
    late: s.submittedAt >= dueAt,
  });

  async function readSubmission(input: SubmissionInput) {
    if ("pdf" in input) {
      if (input.pdf.byteLength > MAX_PDF_BYTES) {
        throw new DomainError("submission.too-big", "That PDF is over 10 MB. Try a smaller file or paste your work.");
      }
      const extracted = await pdfText(input.pdf);
      if (extracted === null) throw new DomainError("submission.bad-pdf", "That file isn't a PDF we can read.");
      const text = extracted.trim();
      if (!text) {
        throw new DomainError("submission.empty-pdf", "No text could be read from that PDF. Paste your work instead.");
      }
      return { text, fileHash: await files.put(input.pdf), fileName: input.fileName.trim() || "submission.pdf" };
    }
    const text = input.text.trim();
    if (!text) throw new DomainError("submission.empty", "Write or paste your work first.");
    return { text, fileHash: null, fileName: null };
  }

  function lecturerView(assignmentId: number): LecturerAssignment {
    const row = assignmentRow(assignmentId);
    const roster = new Map(course.listRoster(row.courseId).map((e) => [e.id, e]));
    const submissions = db
      .select()
      .from(submissionTable)
      .where(eq(submissionTable.assignmentId, assignmentId))
      .orderBy(asc(submissionTable.submittedAt))
      .all()
      .map((s) => ({
        id: s.id,
        rosterEntryId: s.rosterEntryId,
        studentName: roster.get(s.rosterEntryId)?.name ?? "Unknown Student",
        studentId: roster.get(s.rosterEntryId)?.studentId ?? "",
        submittedAt: s.submittedAt.toISOString(),
        late: s.submittedAt >= row.dueAt,
        fileName: s.fileName,
      }));
    return { ...toAssignment(row), state: stateOf(row.dueAt), submissions };
  }

  return {
    setAssignment(courseId, input, assignmentId) {
      course.courseSummary(courseId);
      const { title, instructions, dueAt, labels } = read(input);
      const id = db.transaction((tx) => {
        let id: number;
        if (assignmentId === undefined) {
          id = tx
            .insert(assignmentTable)
            .values({ courseId, title, instructions, dueAt, createdAt: clock.now() })
            .returning({ id: assignmentTable.id })
            .get().id;
        } else {
          const existing = tx.select().from(assignmentTable).where(eq(assignmentTable.id, assignmentId)).get();
          if (!existing || existing.courseId !== courseId) throw new NotFoundError("Assignment");
          id = existing.id;
          tx.update(assignmentTable).set({ title, instructions, dueAt }).where(eq(assignmentTable.id, id)).run();
        }
        // Criteria keep their ids by position, so later Reviews still point at the right one.
        const current = tx
          .select()
          .from(criterion)
          .where(eq(criterion.assignmentId, id))
          .orderBy(asc(criterion.position))
          .all();
        labels.forEach((label, position) => {
          const at = current[position];
          if (at) tx.update(criterion).set({ label }).where(eq(criterion.id, at.id)).run();
          else tx.insert(criterion).values({ assignmentId: id, label, position }).run();
        });
        const extra = current.slice(labels.length).map((c) => c.id);
        if (extra.length) tx.delete(criterion).where(inArray(criterion.id, extra)).run();
        return id;
      });
      changed(courseId, id);
      return lecturerView(id);
    },

    async draftCriteria({ title, instructions }) {
      if (!instructions.trim()) {
        throw new DomainError("assignment.no-instructions", "Write the instructions first, then draft Criteria from them.");
      }
      const result = await llm.generate(draftCriteriaTask, { title: title.trim(), instructions: instructions.trim() });
      if (!result.ok) throw new DomainError("assignment.draft-failed", result.error.message);
      return result.value.criteria;
    },

    lecturerView,

    async submit(assignmentId, rosterEntryId, input) {
      const row = assignmentRow(assignmentId);
      studentOn(row.courseId, rosterEntryId);
      const read = await readSubmission(input);
      const now = clock.now();
      // Checked after the slow extraction, against the time the Submission is stored.
      if (now >= row.dueAt && submissionRow(assignmentId, rosterEntryId)) {
        throw new DomainError("submission.closed", "The due date has passed, so your Submission can't be replaced.");
      }
      const values = { assignmentId, rosterEntryId, ...read, submittedAt: now };
      const saved = db
        .insert(submissionTable)
        .values(values)
        .onConflictDoUpdate({
          target: [submissionTable.assignmentId, submissionTable.rosterEntryId],
          set: values,
        })
        .returning()
        .get();
      changed(row.courseId, assignmentId, "lecturer");
      return toStudentSubmission(saved, row.dueAt);
    },

    studentView(assignmentId, rosterEntryId) {
      const row = assignmentRow(assignmentId);
      studentOn(row.courseId, rosterEntryId);
      const mine = submissionRow(assignmentId, rosterEntryId);
      const state = stateOf(row.dueAt);
      return {
        ...toAssignment(row),
        state,
        submission: mine ? toStudentSubmission(mine, row.dueAt) : null,
        canReplace: state === "open" || !mine,
      };
    },

    forStudent(courseId, rosterEntryId) {
      studentOn(courseId, rosterEntryId);
      const rows = db
        .select()
        .from(assignmentTable)
        .where(eq(assignmentTable.courseId, courseId))
        .orderBy(asc(assignmentTable.dueAt), asc(assignmentTable.id))
        .all();
      if (rows.length === 0) return [];
      const mine = new Map(
        db
          .select()
          .from(submissionTable)
          .where(
            and(
              eq(submissionTable.rosterEntryId, rosterEntryId),
              inArray(submissionTable.assignmentId, rows.map((r) => r.id)),
            ),
          )
          .all()
          .map((s) => [s.assignmentId, s]),
      );
      return rows.map((r) => {
        const s = mine.get(r.id);
        return {
          id: r.id,
          title: r.title,
          dueAt: r.dueAt.toISOString(),
          state: stateOf(r.dueAt),
          submitted: !!s,
          late: !!s && s.submittedAt >= r.dueAt,
        };
      });
    },

    forCourse(courseId) {
      const rows = db
        .select()
        .from(assignmentTable)
        .where(eq(assignmentTable.courseId, courseId))
        .orderBy(asc(assignmentTable.dueAt), asc(assignmentTable.id))
        .all();
      if (rows.length === 0) return [];
      const counts = new Map<number, number>();
      for (const s of db
        .select({ assignmentId: submissionTable.assignmentId })
        .from(submissionTable)
        .where(inArray(submissionTable.assignmentId, rows.map((r) => r.id)))
        .all()) {
        counts.set(s.assignmentId, (counts.get(s.assignmentId) ?? 0) + 1);
      }
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        dueAt: r.dueAt.toISOString(),
        state: stateOf(r.dueAt),
        submissionCount: counts.get(r.id) ?? 0,
      }));
    },
  };
}
