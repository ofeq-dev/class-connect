import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Clock } from "../clock";
import type { CourseModule } from "../course";
import type { Db } from "../db";
import { DomainError, NotFoundError } from "../errors";
import type { FileStore } from "../files";
import { MAX_ATTEMPTS, type Job, type Jobs, type JobStatus } from "../jobs";
import type { LiveEvents } from "../live-events";
import type { LlmGateway } from "../llm";
import { classSummary as classSummaryTask } from "./class-summary-task";
import { draftCriteria as draftCriteriaTask } from "./draft-criteria-task";
import { pdfText } from "./pdf";
import { LEVELS, reviewSubmission, type Level } from "./review-task";
import {
  assignment as assignmentTable,
  classSummary as classSummaryTable,
  criterion,
  review as reviewTable,
  reviewJob,
  reviewLevel,
  reviewRun,
  similarityPair,
  submission as submissionTable,
} from "./schema";
import { compareFingerprints, cosine, fingerprint, SIMILARITY_THRESHOLD, similarityScore } from "./similarity";

export { LEVELS, type Level, type ReviewSubmissionInput } from "./review-task";

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

/** What a Student sees: open until the due date, due after it. */
export type AssignmentState = "open" | "due";

/** The Lecturer's states add the review run: reviewing while it works, reviewed once it settles. */
export type LecturerAssignmentState = AssignmentState | "reviewing" | "reviewed";

export interface ReviewLevel {
  criterionId: number;
  level: Level;
  evidence: string;
  feedback: string;
}

/** not-started (no run has included it), queued / running / failed (its job), drafted (a Review exists). */
export type ReviewStatus = "not-started" | "queued" | "running" | "failed" | "drafted";

export interface LecturerReview {
  status: ReviewStatus;
  /** The failed job's error, for the Retry row. */
  error: string | null;
  /** Who wrote the Review first; null without one. */
  author: "ai" | "lecturer" | null;
  editedAt: string | null;
  /** One per Criterion, in the Criteria's order; empty without a Review. */
  levels: ReviewLevel[];
}

export interface ReviewRunView {
  /** Drafts settled (written or failed for good), of the run's Submissions; counted from job rows. */
  done: number;
  total: number;
  failed: number;
  /** The latest review.compare job's status, null until the drafts settle. */
  compare: JobStatus | null;
  /** The latest review.classSummary job's status, null until compare finishes. */
  classSummary: JobStatus | null;
  /** The comparison's or the class summary's error when it failed. */
  error: string | null;
}

/** For the Lecturer only. */
export interface SimilarPair {
  a: { submissionId: number; studentName: string };
  b: { submissionId: number; studentName: string };
  score: number;
  fingerprintOverlap: number;
  /** Null when the embedding call failed on its last attempt; the score is then the fingerprints'. */
  embeddingSimilarity: number | null;
  /** The overlapping passages side by side. */
  passages: { a: string; b: string }[];
}

/** Anonymised: counts per Criterion and common mistakes, from the Reviews written when it ran. */
export interface ClassSummary {
  reviewCount: number;
  counts: { criterionId: number; label: string; notYet: number; partly: number; secure: number }[];
  commonMistakes: string[];
}

export interface LecturerSubmission {
  id: number;
  rosterEntryId: number;
  studentName: string;
  studentId: string;
  submittedAt: string;
  late: boolean;
  fileName: string | null;
  /** The pasted or extracted text, for reviewing by hand. */
  text: string;
  review: LecturerReview;
}

export interface LecturerAssignment extends Assignment {
  state: LecturerAssignmentState;
  /** Oldest first. */
  submissions: LecturerSubmission[];
  /** The latest review run, or null before the first. */
  reviewRun: ReviewRunView | null;
  /** Above the similarity threshold, highest score first. Never shown to Students. */
  similarPairs: SimilarPair[];
  classSummary: ClassSummary | null;
}

export interface AssignmentRow {
  id: number;
  title: string;
  dueAt: string;
  state: LecturerAssignmentState;
  submissionCount: number;
  /** The latest review run's `n of m`, or null before the first. */
  reviewRun: { done: number; total: number } | null;
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
  /**
   * After the due date: queues one `review.submission` job per Submission without a Review. The
   * job settling the run's last draft queues `review.compare`, which queues `review.classSummary`.
   */
  startReviewRun(assignmentId: number): LecturerAssignment;
  /** Queues a failed draft again with fresh attempts. */
  retryReview(assignmentId: number, submissionId: number): LecturerAssignment;
  /**
   * The Lecturer's Review of a Submission: a level, evidence and feedback for every Criterion.
   * Edits a draft, or writes one by hand (e.g. for a failed draft).
   */
  editReview(assignmentId: number, submissionId: number, levels: ReviewLevel[]): LecturerAssignment;
}

export interface HomeworkDeps {
  db: Db;
  clock: Clock;
  course: CourseModule;
  llm: LlmGateway;
  files: FileStore;
  events: LiveEvents;
  jobs: Jobs;
}

export function createHomeworkModule({ db, clock, course, llm, files, events, jobs }: HomeworkDeps): HomeworkModule {
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

  // ---- Review run -------------------------------------------------------------------------

  const latestRun = (assignmentId: number) =>
    db
      .select()
      .from(reviewRun)
      .where(eq(reviewRun.assignmentId, assignmentId))
      .orderBy(desc(reviewRun.id))
      .limit(1)
      .get();

  const runJobIds = (runId: number) =>
    db
      .select({ jobId: reviewJob.jobId })
      .from(reviewJob)
      .where(eq(reviewJob.runId, runId))
      .all()
      .map((r) => r.jobId);

  function runProgress(runId: number): { done: number; total: number; failed: number; unsettled: number } {
    const tally = jobs.tally(runJobIds(runId));
    return {
      done: tally.done + tally.failed,
      total: tally.total,
      failed: tally.failed,
      unsettled: tally.queued + tally.running,
    };
  }

  const jobStatus = (jobId: number | null): JobStatus | null => (jobId ? jobs.read(jobId).status : null);
  const busy = (status: JobStatus | null) => status === "queued" || status === "running";

  /** reviewing while any draft, the comparison or the class summary is still to run. */
  function runState(run: typeof reviewRun.$inferSelect | undefined): "reviewing" | "reviewed" | null {
    if (!run) return null;
    if (runProgress(run.id).unsettled > 0) return "reviewing";
    if (busy(jobStatus(run.compareJobId)) || busy(jobStatus(run.classSummaryJobId))) return "reviewing";
    return "reviewed";
  }

  function lecturerStateOf(row: typeof assignmentTable.$inferSelect): LecturerAssignmentState {
    return runState(latestRun(row.id)) ?? stateOf(row.dueAt);
  }

  /** Each Submission's Review with its levels in Criteria order. */
  function reviewsOf(submissionIds: number[], criteria: Criterion[]) {
    const out = new Map<number, { review: typeof reviewTable.$inferSelect; levels: ReviewLevel[] }>();
    if (submissionIds.length === 0) return out;
    const reviews = db.select().from(reviewTable).where(inArray(reviewTable.submissionId, submissionIds)).all();
    if (reviews.length === 0) return out;
    const position = new Map(criteria.map((c, i) => [c.id, i]));
    const levels = db
      .select()
      .from(reviewLevel)
      .where(inArray(reviewLevel.reviewId, reviews.map((r) => r.id)))
      .all();
    for (const review of reviews) {
      out.set(review.submissionId, {
        review,
        levels: levels
          .filter((l) => l.reviewId === review.id && position.has(l.criterionId))
          .sort((a, b) => position.get(a.criterionId)! - position.get(b.criterionId)!)
          .map((l) => ({ criterionId: l.criterionId, level: l.level as Level, evidence: l.evidence, feedback: l.feedback })),
      });
    }
    return out;
  }

  /** Each Submission's newest review.submission job. */
  function latestJobs(submissionIds: number[]) {
    const out = new Map<number, number>();
    if (submissionIds.length === 0) return out;
    for (const r of db
      .select({ submissionId: reviewJob.submissionId, jobId: reviewJob.jobId })
      .from(reviewJob)
      .where(inArray(reviewJob.submissionId, submissionIds))
      .orderBy(asc(reviewJob.id))
      .all()) {
      out.set(r.submissionId, r.jobId);
    }
    return out;
  }

  function lecturerView(assignmentId: number): LecturerAssignment {
    const row = assignmentRow(assignmentId);
    const assignment = toAssignment(row);
    const roster = new Map(course.listRoster(row.courseId).map((e) => [e.id, e]));
    const rows = db
      .select()
      .from(submissionTable)
      .where(eq(submissionTable.assignmentId, assignmentId))
      .orderBy(asc(submissionTable.submittedAt))
      .all();
    const ids = rows.map((s) => s.id);
    const reviews = reviewsOf(ids, assignment.criteria);
    const jobIds = latestJobs(ids);
    const submissions = rows.map((s) => {
      const written = reviews.get(s.id);
      const jobId = jobIds.get(s.id);
      const job = jobId ? jobs.read(jobId) : null;
      const review: LecturerReview = written
        ? {
            status: "drafted",
            error: null,
            author: written.review.author as "ai" | "lecturer",
            editedAt: written.review.editedAt?.toISOString() ?? null,
            levels: written.levels,
          }
        : {
            status: job && job.status !== "done" ? job.status : "not-started",
            error: job?.status === "failed" ? job.error : null,
            author: null,
            editedAt: null,
            levels: [],
          };
      return {
        id: s.id,
        rosterEntryId: s.rosterEntryId,
        studentName: roster.get(s.rosterEntryId)?.name ?? "Unknown Student",
        studentId: roster.get(s.rosterEntryId)?.studentId ?? "",
        submittedAt: s.submittedAt.toISOString(),
        late: s.submittedAt >= row.dueAt,
        fileName: s.fileName,
        text: s.text,
        review,
      };
    });
    const run = latestRun(assignmentId);
    let reviewRunView: ReviewRunView | null = null;
    if (run) {
      const { done, total, failed } = runProgress(run.id);
      const compare = run.compareJobId ? jobs.read(run.compareJobId) : null;
      const summary = run.classSummaryJobId ? jobs.read(run.classSummaryJobId) : null;
      const error = compare?.status === "failed" ? compare.error : summary?.status === "failed" ? summary.error : null;
      reviewRunView = {
        done,
        total,
        failed,
        compare: compare?.status ?? null,
        classSummary: summary?.status ?? null,
        error,
      };
    }
    const names = new Map(submissions.map((s) => [s.id, s.studentName]));
    const similarPairs = db
      .select()
      .from(similarityPair)
      .where(eq(similarityPair.assignmentId, assignmentId))
      .orderBy(desc(similarityPair.score))
      .all()
      .map((p) => ({
        a: { submissionId: p.submissionAId, studentName: names.get(p.submissionAId) ?? "Unknown Student" },
        b: { submissionId: p.submissionBId, studentName: names.get(p.submissionBId) ?? "Unknown Student" },
        score: p.score,
        fingerprintOverlap: p.fingerprintOverlap,
        embeddingSimilarity: p.embeddingSimilarity,
        passages: JSON.parse(p.passages) as SimilarPair["passages"],
      }));
    return {
      ...assignment,
      state: runState(run) ?? stateOf(row.dueAt),
      submissions,
      reviewRun: reviewRunView,
      similarPairs,
      classSummary: readClassSummary(assignment),
    };
  }

  function readClassSummary(assignment: Assignment): ClassSummary | null {
    const row = db.select().from(classSummaryTable).where(eq(classSummaryTable.assignmentId, assignment.id)).get();
    if (!row) return null;
    const stored = JSON.parse(row.counts) as { reviewCount: number; perCriterion: Omit<ClassSummary["counts"][number], "label">[] };
    const labels = new Map(assignment.criteria.map((c) => [c.id, c.label]));
    return {
      reviewCount: stored.reviewCount,
      counts: stored.perCriterion
        .filter((c) => labels.has(c.criterionId))
        .map((c) => ({ ...c, label: labels.get(c.criterionId)! })),
      commonMistakes: JSON.parse(row.commonMistakes) as string[],
    };
  }

  const lecturerChanged = (courseId: number, assignmentId: number) => changed(courseId, assignmentId, "lecturer");

  function publishProgress(courseId: number, assignmentId: number, runId: number) {
    const { done, total } = runProgress(runId);
    events.publish(courseId, "lecturer", { type: "job.progress", id: assignmentId, progress: { done, total } });
  }

  /**
   * Called inside the transaction that settles one of the run's drafts (written, or failed for
   * good), while that job is still `running`. When it was the last unsettled one, queues
   * review.compare: always when the run settles for the first time, and again after a
   * successful Retry. Jobs share the database connection, so the enqueue commits or rolls back
   * with the transaction.
   */
  function settleDraft(runId: number, succeeded: boolean) {
    const run = db.select().from(reviewRun).where(eq(reviewRun.id, runId)).get();
    if (!run) return;
    const othersUnsettled = runProgress(runId).unsettled - 1;
    if (othersUnsettled > 0) return;
    if (!succeeded && run.compareJobId !== null) return;
    const compare = jobs.enqueue("review.compare", { runId });
    db.update(reviewRun).set({ compareJobId: compare.id, classSummaryJobId: null }).where(eq(reviewRun.id, runId)).run();
  }

  /** Replaces a Submission's Review levels, making the Review if there is none. */
  function writeReview(submissionId: number, levels: ReviewLevel[], author: "ai" | "lecturer") {
    const now = clock.now();
    const existing = db.select().from(reviewTable).where(eq(reviewTable.submissionId, submissionId)).get();
    const reviewId = existing
      ? db
          .update(reviewTable)
          .set(author === "lecturer" ? { editedAt: now } : { author, createdAt: now, editedAt: null })
          .where(eq(reviewTable.id, existing.id))
          .returning({ id: reviewTable.id })
          .get().id
      : db.insert(reviewTable).values({ submissionId, author, createdAt: now }).returning({ id: reviewTable.id }).get().id;
    db.delete(reviewLevel).where(eq(reviewLevel.reviewId, reviewId)).run();
    for (const l of levels) db.insert(reviewLevel).values({ reviewId, ...l }).run();
  }

  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /**
   * Runs a step's slow work, then its write via Jobs.complete. A failure before its last attempt
   * is thrown so the worker queues it again; on the last attempt `onLastFailure` settles it.
   */
  async function attempt<T>(job: Job, work: () => Promise<T>, onLastFailure: (error: string) => void): Promise<T | null> {
    try {
      return await work();
    } catch (error) {
      if (job.attempts < MAX_ATTEMPTS) throw error;
      onLastFailure(errorText(error));
      return null;
    }
  }

  async function handleReviewSubmission(job: Job) {
    const { runId, submissionId } = job.payload as { runId: number; submissionId: number };
    const sub = db.select().from(submissionTable).where(eq(submissionTable.id, submissionId)).get();
    if (!sub) return jobs.fail(job, "The Submission is gone.", () => settleDraft(runId, false));
    const row = assignmentRow(sub.assignmentId);
    const criteria = criteriaOf(row.id);

    const draft = await attempt(
      job,
      async () => {
        const result = await llm.generate(reviewSubmission(criteria.length), {
          instructions: row.instructions,
          criteria: criteria.map((c) => c.label),
          text: sub.text,
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      },
      (error) => jobs.fail(job, error, () => settleDraft(runId, false)),
    );
    if (draft) {
      jobs.complete(job, () => {
        writeReview(
          submissionId,
          draft.levels.map((l, i) => ({ criterionId: criteria[i]!.id, ...l })),
          "ai",
        );
        settleDraft(runId, true);
      });
    }
    publishProgress(row.courseId, row.id, runId);
    lecturerChanged(row.courseId, row.id);
  }

  jobs.register("review.submission", handleReviewSubmission);

  /**
   * A run step (compare, class summary) that the worker retries; on its last attempt it is failed
   * here, so the Lecturer can be told once the failure is saved.
   */
  function failingOnLastAttempt(handler: (job: Job) => Promise<void>) {
    return async (job: Job) => {
      try {
        await handler(job);
      } catch (error) {
        if (job.attempts < MAX_ATTEMPTS) throw error;
        jobs.fail(job, errorText(error));
        const run = db.select().from(reviewRun).where(eq(reviewRun.id, (job.payload as { runId: number }).runId)).get();
        const row = run && db.select().from(assignmentTable).where(eq(assignmentTable.id, run.assignmentId)).get();
        if (row) lecturerChanged(row.courseId, row.id);
      }
    };
  }

  /** The Assignment's Submissions that have a Review: compare and the class summary run on these. */
  function reviewedSubmissions(assignmentId: number) {
    return db
      .select({ id: submissionTable.id, text: submissionTable.text })
      .from(submissionTable)
      .innerJoin(reviewTable, eq(reviewTable.submissionId, submissionTable.id))
      .where(eq(submissionTable.assignmentId, assignmentId))
      .orderBy(asc(submissionTable.id))
      .all();
  }

  function runOf(runId: number) {
    const run = db.select().from(reviewRun).where(eq(reviewRun.id, runId)).get();
    if (!run) throw new Error("The review run is gone.");
    return { run, row: assignmentRow(run.assignmentId) };
  }

  async function handleCompare(job: Job) {
    const { runId } = job.payload as { runId: number };
    const { row } = runOf(runId);
    const subs = reviewedSubmissions(row.id);
    const prints = subs.map((s) => fingerprint(s.text));

    // One batched embedding call. If it fails on the last attempt, the fingerprints decide alone.
    let vectors: number[][] | null = null;
    if (subs.length >= 2) {
      vectors = await attempt(
        job,
        () => llm.embed(subs.map((s) => s.text)),
        () => {},
      );
    }

    const pairs: (typeof similarityPair.$inferInsert)[] = [];
    for (let i = 0; i < subs.length; i++) {
      for (let j = i + 1; j < subs.length; j++) {
        const { fingerprintOverlap, passages } = compareFingerprints(prints[i]!, prints[j]!);
        const embeddingSimilarity = vectors ? cosine(vectors[i]!, vectors[j]!) : null;
        const score = similarityScore(fingerprintOverlap, embeddingSimilarity);
        if (score < SIMILARITY_THRESHOLD) continue;
        pairs.push({
          assignmentId: row.id,
          submissionAId: subs[i]!.id,
          submissionBId: subs[j]!.id,
          score,
          fingerprintOverlap,
          embeddingSimilarity,
          passages: JSON.stringify(passages),
        });
      }
    }

    jobs.complete(job, () => {
      db.delete(similarityPair).where(eq(similarityPair.assignmentId, row.id)).run();
      for (const p of pairs) db.insert(similarityPair).values(p).run();
      const next = jobs.enqueue("review.classSummary", { runId });
      db.update(reviewRun).set({ classSummaryJobId: next.id }).where(eq(reviewRun.id, runId)).run();
    });
    lecturerChanged(row.courseId, row.id);
  }

  jobs.register("review.compare", failingOnLastAttempt(handleCompare));

  async function handleClassSummary(job: Job) {
    const { runId } = job.payload as { runId: number };
    const { row } = runOf(runId);
    const criteria = criteriaOf(row.id);
    const reviews = reviewsOf(
      reviewedSubmissions(row.id).map((s) => s.id),
      criteria,
    );
    const levels = [...reviews.values()].map((r) => r.levels);
    const perCriterion = criteria.map((c) => {
      const count = { criterionId: c.id, notYet: 0, partly: 0, secure: 0 };
      for (const review of levels) {
        const level = review.find((l) => l.criterionId === c.id)?.level;
        if (level === "not-yet") count.notYet++;
        else if (level === "partly") count.partly++;
        else if (level === "secure") count.secure++;
      }
      return count;
    });

    let commonMistakes: string[] = [];
    if (levels.length > 0) {
      const result = await llm.generate(classSummaryTask, {
        instructions: row.instructions,
        criteria: criteria.map((c) => c.label),
        reviews: levels.map((r) => r.map((l) => ({ level: l.level, feedback: l.feedback }))),
      });
      if (!result.ok) throw new Error(result.error.message);
      commonMistakes = result.value.commonMistakes;
    }

    const values = {
      assignmentId: row.id,
      counts: JSON.stringify({ reviewCount: levels.length, perCriterion }),
      commonMistakes: JSON.stringify(commonMistakes),
      createdAt: clock.now(),
    };
    jobs.complete(job, () => {
      db.insert(classSummaryTable)
        .values(values)
        .onConflictDoUpdate({ target: classSummaryTable.assignmentId, set: values })
        .run();
    });
    lecturerChanged(row.courseId, row.id);
  }

  jobs.register("review.classSummary", failingOnLastAttempt(handleClassSummary));

  /** A Submission of this Assignment, else 404. */
  function submissionOf(assignmentId: number, submissionId: number) {
    const sub = db.select().from(submissionTable).where(eq(submissionTable.id, submissionId)).get();
    if (!sub || sub.assignmentId !== assignmentId) throw new NotFoundError("Submission");
    return sub;
  }

  function readLevels(criteria: Criterion[], levels: ReviewLevel[]): ReviewLevel[] {
    const given = new Map<number, ReviewLevel>();
    for (const l of levels) {
      if (given.has(l.criterionId)) throw new DomainError("review.criterion-twice", "A Criterion appears twice.");
      given.set(l.criterionId, l);
    }
    if (given.size !== criteria.length || criteria.some((c) => !given.has(c.id))) {
      throw new DomainError("review.criteria", "Give a level and feedback for every Criterion.");
    }
    return criteria.map((c) => {
      const l = given.get(c.id)!;
      if (!LEVELS.includes(l.level)) {
        throw new DomainError("review.level", `Pick Not yet, Partly or Secure for "${c.label}".`);
      }
      const feedback = (l.feedback ?? "").trim();
      if (!feedback) throw new DomainError("review.no-feedback", `Write feedback for "${c.label}".`);
      return { criterionId: c.id, level: l.level, evidence: (l.evidence ?? "").trim(), feedback };
    });
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

    startReviewRun(assignmentId) {
      const row = assignmentRow(assignmentId);
      if (stateOf(row.dueAt) === "open") {
        throw new DomainError("review.not-due", "The review run starts after the due date.");
      }
      if (runState(latestRun(assignmentId)) === "reviewing") {
        throw new DomainError("review.running", "A review run is already going.");
      }
      const reviewed = new Set(
        db
          .select({ submissionId: reviewTable.submissionId })
          .from(reviewTable)
          .innerJoin(submissionTable, eq(submissionTable.id, reviewTable.submissionId))
          .where(eq(submissionTable.assignmentId, assignmentId))
          .all()
          .map((r) => r.submissionId),
      );
      const toReview = db
        .select({ id: submissionTable.id })
        .from(submissionTable)
        .where(eq(submissionTable.assignmentId, assignmentId))
        .orderBy(asc(submissionTable.submittedAt))
        .all()
        .filter((s) => !reviewed.has(s.id));
      if (toReview.length === 0) {
        throw new DomainError("review.nothing-to-review", "Every Submission already has a Review.");
      }
      const runId = db.transaction(() => {
        const run = db.insert(reviewRun).values({ assignmentId, startedAt: clock.now() }).returning().get();
        for (const s of toReview) {
          const job = jobs.enqueue("review.submission", { runId: run.id, submissionId: s.id });
          db.insert(reviewJob).values({ runId: run.id, submissionId: s.id, jobId: job.id }).run();
        }
        return run.id;
      });
      publishProgress(row.courseId, assignmentId, runId);
      lecturerChanged(row.courseId, assignmentId);
      return lecturerView(assignmentId);
    },

    retryReview(assignmentId, submissionId) {
      const row = assignmentRow(assignmentId);
      submissionOf(assignmentId, submissionId);
      const jobId = latestJobs([submissionId]).get(submissionId);
      const hasReview = db.select().from(reviewTable).where(eq(reviewTable.submissionId, submissionId)).get();
      if (!jobId || hasReview || jobs.read(jobId).status !== "failed") {
        throw new DomainError("review.nothing-to-retry", "There's no failed draft to retry for this Submission.");
      }
      jobs.retry(jobId);
      const runId = db.select({ runId: reviewJob.runId }).from(reviewJob).where(eq(reviewJob.jobId, jobId)).get()!.runId;
      publishProgress(row.courseId, assignmentId, runId);
      lecturerChanged(row.courseId, assignmentId);
      return lecturerView(assignmentId);
    },

    editReview(assignmentId, submissionId, levels) {
      const row = assignmentRow(assignmentId);
      submissionOf(assignmentId, submissionId);
      const jobId = latestJobs([submissionId]).get(submissionId);
      if (jobId && busy(jobs.read(jobId).status)) {
        throw new DomainError("review.drafting", "This Submission is still being drafted. Wait for it to finish.");
      }
      const read = readLevels(criteriaOf(assignmentId), levels);
      db.transaction(() => writeReview(submissionId, read, "lecturer"));
      lecturerChanged(row.courseId, assignmentId);
      return lecturerView(assignmentId);
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
      return rows.map((r) => {
        const run = latestRun(r.id);
        const progress = run ? runProgress(run.id) : null;
        return {
          id: r.id,
          title: r.title,
          dueAt: r.dueAt.toISOString(),
          state: lecturerStateOf(r),
          submissionCount: counts.get(r.id) ?? 0,
          reviewRun: progress ? { done: progress.done, total: progress.total } : null,
        };
      });
    },
  };
}
