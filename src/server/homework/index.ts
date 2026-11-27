import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Clock } from "../clock";
import type { CourseModule } from "../course";
import type { Db } from "../db";
import { DomainError, NotFoundError } from "../errors";
import type { FileStore } from "../files";
import type { Job, Jobs, JobStatus } from "../jobs";
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
  helpMatch,
  helpOffer,
  helpRequest,
  review as reviewTable,
  reviewJob,
  reviewLevel,
  reviewRun,
  similarityPair,
  submission as submissionTable,
} from "./schema";
import { compareFingerprints, cosine, fingerprint, SIMILARITY_THRESHOLD, similarityScore } from "./similarity";

export { LEVELS, reviewSubmission, type Level, type ReviewSubmissionInput } from "./review-task";
/** The LLM tasks, for the fake adapter's rehearsal fixtures (validated with the same schemas). */
export { classSummary, type ClassSummaryInput } from "./class-summary-task";
export { draftCriteria, type DraftCriteriaInput } from "./draft-criteria-task";

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

/** A Student's states add Release, after which their Review and the class summary show. */
export type StudentAssignmentState = AssignmentState | "released";

/**
 * The Lecturer's states add the review run (reviewing while it works, reviewed once it settles),
 * then Release and the Help matching pass.
 */
export type LecturerAssignmentState = AssignmentState | "reviewing" | "reviewed" | "released" | "matched";

/** A Helper takes at most this many Help requests per Criterion. */
export const MAX_MATCHES_PER_HELPER = 2;
/** Two days after Release, unless the Lecturer picks another match deadline. */
export const DEFAULT_MATCH_DELAY_MS = 2 * 24 * 60 * 60 * 1000;
/** Students see the class summary only when at least this many Reviews went into it. */
export const MIN_CLASS_SUMMARY_REVIEWS = 5;

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
  /** When the Student could first see it: at Release, or on its own for a Late one after it. */
  releasedAt: string | null;
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

/**
 * Anonymised: counts per Criterion and common mistakes. The counts are from the Reviews when the
 * run wrote it, then from the Reviews released at Release, after which it stays as it is.
 */
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

export interface StudentRef {
  rosterEntryId: number;
  name: string;
}

/** For the Lecturer only: every Help request, offer and match of the Assignment. */
export interface LecturerHelp {
  /** Oldest first. */
  requests: {
    id: number;
    criterionId: number;
    criterion: string;
    student: StudentRef;
    level: Level;
    createdAt: string;
    helper: StudentRef | null;
  }[];
  /** Oldest first. */
  offers: { id: number; criterionId: number; criterion: string; student: StudentRef; createdAt: string; matched: StudentRef[] }[];
  /** In Criteria order. */
  matches: { criterionId: number; criterion: string; student: StudentRef; helper: StudentRef }[];
}

/**
 * A Student's Help on one Criterion. Before matching they can ask (Not yet / Partly) or offer
 * (Secure); after it they see who they're paired with, "No Helper this time", or a thank-you.
 * Nobody else's level is ever in it.
 */
export type HelpState =
  | { kind: "can-ask" }
  | { kind: "can-offer" }
  | { kind: "asked" }
  | { kind: "offered" }
  | { kind: "paired"; with: string[] }
  | { kind: "no-helper" }
  | { kind: "thanks" }
  | { kind: "closed" };

export interface LecturerAssignment extends Assignment {
  state: LecturerAssignmentState;
  /** Oldest first. */
  submissions: LecturerSubmission[];
  /** The latest review run, or null before the first. */
  reviewRun: ReviewRunView | null;
  /** Above the similarity threshold, highest score first. Never shown to Students. */
  similarPairs: SimilarPair[];
  classSummary: ClassSummary | null;
  releasedAt: string | null;
  matchDeadline: string | null;
  matchedAt: string | null;
  /** Why Release is refused right now; null when it can go ahead, or once Released. */
  releaseBlocker: string | null;
  help: LecturerHelp;
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

/** The Student's own released Review. */
export interface StudentReview {
  levels: (ReviewLevel & { label: string })[];
}

export interface StudentAssignment extends Assignment {
  state: StudentAssignmentState;
  submission: StudentSubmission | null;
  /** Until the due date a Student can hand in or replace; after it only a first, Late, Submission. */
  canReplace: boolean;
  /** Their own Review once released; never anyone else's. */
  review: StudentReview | null;
  /** After Release, when at least MIN_CLASS_SUMMARY_REVIEWS Reviews went into it. */
  classSummary: Omit<ClassSummary, "reviewCount"> | null;
  /** True after Release when the class summary is held back for having too few Reviews. */
  classSummaryHidden: boolean;
  /** One per Criterion once the Student's own Review is released; empty before. */
  help: { criterionId: number; label: string; state: HelpState }[];
  /** When matching runs unless the Lecturer matches first; null before Release. */
  matchDeadline: string | null;
}

export interface StudentAssignmentRow {
  id: number;
  title: string;
  dueAt: string;
  state: StudentAssignmentState;
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
  /**
   * Publishes every Review and the class summary at once and opens Help until the match
   * deadline (an instant; default two days on), when `help.match` runs. Refused before the due
   * date, while a run is going, while an on-time Submission has no Review, and a second time.
   */
  release(assignmentId: number, matchDeadline?: string): LecturerAssignment;
  /** After Release, a Late Submission's Review goes to its Student on its own. */
  releaseReview(assignmentId: number, submissionId: number): LecturerAssignment;
  /** A Help request on a Criterion where the Student's released level is Not yet or Partly, until matching. */
  requestHelp(assignmentId: number, criterionId: number, rosterEntryId: number): StudentAssignment;
  /** A Helper's offer on a Criterion where the Student's released level is Secure, until matching. */
  offerHelp(assignmentId: number, criterionId: number, rosterEntryId: number): StudentAssignment;
  /** Queues `help.match` now; the deadline job then does nothing. Refused before Release and after matching. */
  matchNow(assignmentId: number): LecturerAssignment;
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

  function lecturerStateOf(
    row: typeof assignmentTable.$inferSelect,
    run = latestRun(row.id),
  ): LecturerAssignmentState {
    if (row.matchedAt) return "matched";
    if (row.releasedAt) return "released";
    return runState(run) ?? stateOf(row.dueAt);
  }

  const studentStateOf = (row: typeof assignmentTable.$inferSelect): StudentAssignmentState =>
    row.releasedAt ? "released" : stateOf(row.dueAt);

  /** Why Release can't go ahead now, or null when it can (and once it has). */
  function releaseBlocker(row: typeof assignmentTable.$inferSelect): string | null {
    if (row.releasedAt) return null;
    if (stateOf(row.dueAt) === "open") return "Release opens after the due date.";
    if (runState(latestRun(row.id)) === "reviewing") return "Wait for the review run to finish.";
    const missing = db
      .select({ id: submissionTable.id })
      .from(submissionTable)
      .leftJoin(reviewTable, eq(reviewTable.submissionId, submissionTable.id))
      .where(
        and(
          eq(submissionTable.assignmentId, row.id),
          lt(submissionTable.submittedAt, row.dueAt),
          isNull(reviewTable.id),
        ),
      )
      .all().length;
    if (missing === 0) return null;
    return missing === 1
      ? "1 Submission handed in on time has no Review yet. Retry it or write it by hand."
      : `${missing} Submissions handed in on time have no Review yet. Retry them or write them by hand.`;
  }

  /** Not yet / Partly / Secure counts per Criterion over the given Reviews' levels. */
  function countLevels(criteria: Criterion[], reviews: ReviewLevel[][]) {
    return criteria.map((c) => {
      const count = { criterionId: c.id, notYet: 0, partly: 0, secure: 0 };
      for (const review of reviews) {
        const level = review.find((l) => l.criterionId === c.id)?.level;
        if (level === "not-yet") count.notYet++;
        else if (level === "partly") count.partly++;
        else if (level === "secure") count.secure++;
      }
      return count;
    });
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
            releasedAt: written.review.releasedAt?.toISOString() ?? null,
            levels: written.levels,
          }
        : {
            status: job && job.status !== "done" ? job.status : "not-started",
            error: job?.status === "failed" ? job.error : null,
            author: null,
            editedAt: null,
            releasedAt: null,
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
      state: lecturerStateOf(row, run),
      submissions,
      reviewRun: reviewRunView,
      similarPairs,
      classSummary: readClassSummary(assignment),
      releasedAt: row.releasedAt?.toISOString() ?? null,
      matchDeadline: row.matchDeadline?.toISOString() ?? null,
      matchedAt: row.matchedAt?.toISOString() ?? null,
      releaseBlocker: releaseBlocker(row),
      help: lecturerHelp(assignment, roster),
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

  // ---- Help ----------------------------------------------------------------------------------

  function helpRows(assignmentId: number) {
    const ids = criteriaOf(assignmentId).map((c) => c.id);
    if (ids.length === 0) return { requests: [], offers: [], matches: [] };
    const requests = db
      .select()
      .from(helpRequest)
      .where(inArray(helpRequest.criterionId, ids))
      .orderBy(asc(helpRequest.createdAt), asc(helpRequest.id))
      .all();
    const offers = db
      .select()
      .from(helpOffer)
      .where(inArray(helpOffer.criterionId, ids))
      .orderBy(asc(helpOffer.createdAt), asc(helpOffer.id))
      .all();
    const matches = requests.length
      ? db.select().from(helpMatch).where(inArray(helpMatch.helpRequestId, requests.map((r) => r.id))).all()
      : [];
    return { requests, offers, matches };
  }

  function lecturerHelp(assignment: Assignment, roster: Map<number, { name: string }>): LecturerHelp {
    const { requests, offers, matches } = helpRows(assignment.id);
    const ref = (rosterEntryId: number): StudentRef => ({
      rosterEntryId,
      name: roster.get(rosterEntryId)?.name ?? "Unknown Student",
    });
    const label = new Map(assignment.criteria.map((c) => [c.id, c.label]));
    const position = new Map(assignment.criteria.map((c, i) => [c.id, i]));
    const offerById = new Map(offers.map((o) => [o.id, o]));
    const helperOf = new Map(matches.map((m) => [m.helpRequestId, offerById.get(m.helpOfferId)!]));
    return {
      requests: requests.map((r) => ({
        id: r.id,
        criterionId: r.criterionId,
        criterion: label.get(r.criterionId) ?? "",
        student: ref(r.rosterEntryId),
        level: r.level as Level,
        createdAt: r.createdAt.toISOString(),
        helper: helperOf.has(r.id) ? ref(helperOf.get(r.id)!.rosterEntryId) : null,
      })),
      offers: offers.map((o) => ({
        id: o.id,
        criterionId: o.criterionId,
        criterion: label.get(o.criterionId) ?? "",
        student: ref(o.rosterEntryId),
        createdAt: o.createdAt.toISOString(),
        matched: requests.filter((r) => helperOf.get(r.id)?.id === o.id).map((r) => ref(r.rosterEntryId)),
      })),
      matches: requests
        .filter((r) => helperOf.has(r.id))
        .sort((a, b) => position.get(a.criterionId)! - position.get(b.criterionId)!)
        .map((r) => ({
          criterionId: r.criterionId,
          criterion: label.get(r.criterionId) ?? "",
          student: ref(r.rosterEntryId),
          helper: ref(helperOf.get(r.id)!.rosterEntryId),
        })),
    };
  }

  /** The Student's Help per Criterion; needs their own released Review. */
  function studentHelp(
    row: typeof assignmentTable.$inferSelect,
    assignment: Assignment,
    rosterEntryId: number,
    levels: ReviewLevel[],
  ): StudentAssignment["help"] {
    const roster = new Map(course.listRoster(row.courseId).map((e) => [e.id, e.name]));
    const { requests, offers, matches } = helpRows(assignment.id);
    const nameOf = (id: number) => roster.get(id) ?? "Unknown Student";
    const offerById = new Map(offers.map((o) => [o.id, o]));
    const requestById = new Map(requests.map((r) => [r.id, r]));
    const matched = row.matchedAt !== null;
    return assignment.criteria.map((c) => {
      const level = levels.find((l) => l.criterionId === c.id)?.level;
      const mineAsk = requests.find((r) => r.criterionId === c.id && r.rosterEntryId === rosterEntryId);
      const mineOffer = offers.find((o) => o.criterionId === c.id && o.rosterEntryId === rosterEntryId);
      let state: HelpState;
      if (mineAsk) {
        const m = matches.find((x) => x.helpRequestId === mineAsk.id);
        state = m
          ? { kind: "paired", with: [nameOf(offerById.get(m.helpOfferId)!.rosterEntryId)] }
          : matched
            ? { kind: "no-helper" }
            : { kind: "asked" };
      } else if (mineOffer) {
        const helped = matches
          .filter((x) => x.helpOfferId === mineOffer.id)
          .map((x) => nameOf(requestById.get(x.helpRequestId)!.rosterEntryId));
        state = helped.length ? { kind: "paired", with: helped } : matched ? { kind: "thanks" } : { kind: "offered" };
      } else if (matched || !level) {
        state = { kind: "closed" };
      } else {
        state = level === "secure" ? { kind: "can-offer" } : { kind: "can-ask" };
      }
      return { criterionId: c.id, label: c.label, state };
    });
  }

  /**
   * Checks the Student may ask or offer on the Criterion now, and returns their released level on it:
   * after Release, before matching, with their own Review released.
   */
  function helpLevel(assignmentId: number, criterionId: number, rosterEntryId: number) {
    const row = assignmentRow(assignmentId);
    studentOn(row.courseId, rosterEntryId);
    if (!row.releasedAt) throw new DomainError("help.not-released", "Help opens once the Assignment is Released.");
    if (row.matchedAt) throw new DomainError("help.matched", "Help matching has run, so Help is closed.");
    const criteria = criteriaOf(assignmentId);
    if (!criteria.some((c) => c.id === criterionId)) throw new NotFoundError("Criterion");
    const mine = submissionRow(assignmentId, rosterEntryId);
    const written = mine ? reviewsOf([mine.id], criteria).get(mine.id) : undefined;
    if (!written?.review.releasedAt) {
      throw new DomainError("help.no-review", "Help opens once your Review is released.");
    }
    return { row, level: written.levels.find((l) => l.criterionId === criterionId)!.level };
  }

  /**
   * The one matching pass: Not yet before Partly, earliest first; each request to the Helper on
   * its Criterion with the fewest matches so far in this pass (across the Assignment), the
   * earliest offer on a tie, with at most MAX_MATCHES_PER_HELPER per Helper per Criterion.
   */
  function matchHelp(assignmentId: number): { helpRequestId: number; helpOfferId: number }[] {
    const { requests, offers } = helpRows(assignmentId);
    const rank = (level: string) => (level === "not-yet" ? 0 : 1);
    const queue = [...requests].sort((a, b) => rank(a.level) - rank(b.level)); // stable: earliest first within a level
    const perOffer = new Map<number, number>();
    const perHelper = new Map<number, number>();
    const out: { helpRequestId: number; helpOfferId: number }[] = [];
    for (const r of queue) {
      let best: (typeof offers)[number] | undefined;
      for (const o of offers) {
        if (o.criterionId !== r.criterionId || o.rosterEntryId === r.rosterEntryId) continue;
        if ((perOffer.get(o.id) ?? 0) >= MAX_MATCHES_PER_HELPER) continue;
        if (!best || (perHelper.get(o.rosterEntryId) ?? 0) < (perHelper.get(best.rosterEntryId) ?? 0)) best = o;
      }
      if (!best) continue;
      out.push({ helpRequestId: r.id, helpOfferId: best.id });
      perOffer.set(best.id, (perOffer.get(best.id) ?? 0) + 1);
      perHelper.set(best.rosterEntryId, (perHelper.get(best.rosterEntryId) ?? 0) + 1);
    }
    return out;
  }

  async function handleHelpMatch(job: Job<"help.match">) {
    const { assignmentId } = job.payload;
    const row = db.select().from(assignmentTable).where(eq(assignmentTable.id, assignmentId)).get();
    if (!row) return;
    let ran = false;
    jobs.complete(job, () => {
      // The deadline job after Match now, or a second Match now, finds matched_at set and stops.
      const current = assignmentRow(assignmentId);
      if (!current.releasedAt || current.matchedAt) return;
      for (const m of matchHelp(assignmentId)) db.insert(helpMatch).values(m).run();
      db.update(assignmentTable).set({ matchedAt: clock.now() }).where(eq(assignmentTable.id, assignmentId)).run();
      ran = true;
    });
    if (ran) changed(row.courseId, assignmentId);
  }

  jobs.register("help.match", handleHelpMatch);

  const lecturerChanged = (courseId: number, assignmentId: number) => changed(courseId, assignmentId, "lecturer");

  function publishProgress(courseId: number, assignmentId: number, runId: number) {
    const { done, total } = runProgress(runId);
    events.publish(courseId, "lecturer", { type: "job.progress", id: assignmentId, progress: { done, total } });
  }

  /**
   * Called inside the transaction that settles one of the run's drafts (written, or failed for
   * good). When it was the last unsettled one, queues
   * review.compare: always when the run settles for the first time, and again after a
   * successful Retry. Jobs share the database connection, so the enqueue commits or rolls back
   * with the transaction.
   */
  function settleDraft(runId: number, jobId: number, succeeded: boolean) {
    const run = db.select().from(reviewRun).where(eq(reviewRun.id, runId)).get();
    if (!run) return;
    const others = jobs.tally(runJobIds(runId).filter((id) => id !== jobId));
    const othersUnsettled = others.queued + others.running;
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

  async function handleReviewSubmission(job: Job<"review.submission">) {
    const { runId, submissionId } = job.payload;
    const sub = db.select().from(submissionTable).where(eq(submissionTable.id, submissionId)).get();
    if (!sub) return jobs.fail(job, "The Submission is gone.");
    const row = assignmentRow(sub.assignmentId);
    const criteria = criteriaOf(row.id);
    const result = await llm.generate(reviewSubmission(criteria.length), {
      instructions: row.instructions,
      criteria: criteria.map((c) => c.label),
      text: sub.text,
    });
    // Thrown, so Jobs queues it again; after its last attempt onFailed settles it.
    if (!result.ok) throw new Error(result.error.message);
    jobs.complete(job, () => {
      writeReview(
        submissionId,
        result.value.levels.map((l, i) => ({ criterionId: criteria[i]!.id, ...l })),
        "ai",
      );
      settleDraft(runId, job.id, true);
    });
    publishProgress(row.courseId, row.id, runId);
    lecturerChanged(row.courseId, row.id);
  }

  jobs.register("review.submission", handleReviewSubmission, {
    onFailed(job) {
      const { runId } = job.payload;
      settleDraft(runId, job.id, false);
      const run = db.select().from(reviewRun).where(eq(reviewRun.id, runId)).get();
      const row = run && db.select().from(assignmentTable).where(eq(assignmentTable.id, run.assignmentId)).get();
      if (!row) return;
      publishProgress(row.courseId, row.id, runId);
      lecturerChanged(row.courseId, row.id);
    },
  });

  /** A failed compare or class summary: the Lecturer is told, and sees its error with Retry. */
  function runStepFailed(job: Job<"review.compare" | "review.classSummary">) {
    const run = db.select().from(reviewRun).where(eq(reviewRun.id, job.payload.runId)).get();
    const row = run && db.select().from(assignmentTable).where(eq(assignmentTable.id, run.assignmentId)).get();
    if (row) lecturerChanged(row.courseId, row.id);
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

  async function handleCompare(job: Job<"review.compare">) {
    const { runId } = job.payload;
    const { row } = runOf(runId);
    const subs = reviewedSubmissions(row.id);
    const prints = subs.map((s) => fingerprint(s.text));

    // One batched embedding call. If it fails on the last attempt, the fingerprints decide alone.
    let vectors: number[][] | null = null;
    if (subs.length >= 2) {
      try {
        vectors = await llm.embed(subs.map((s) => s.text));
      } catch (error) {
        if (!job.lastAttempt) throw error;
      }
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
      // After Release the class summary stays as it was released; a Late Submission only joins similarity.
      if (assignmentRow(row.id).releasedAt) return;
      const next = jobs.enqueue("review.classSummary", { runId });
      db.update(reviewRun).set({ classSummaryJobId: next.id }).where(eq(reviewRun.id, runId)).run();
    });
    lecturerChanged(row.courseId, row.id);
  }

  jobs.register("review.compare", handleCompare, { onFailed: runStepFailed });

  async function handleClassSummary(job: Job<"review.classSummary">) {
    const { runId } = job.payload;
    const { row } = runOf(runId);
    const criteria = criteriaOf(row.id);
    const reviews = reviewsOf(
      reviewedSubmissions(row.id).map((s) => s.id),
      criteria,
    );
    const levels = [...reviews.values()].map((r) => r.levels);
    const perCriterion = countLevels(criteria, levels);

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
      if (assignmentRow(row.id).releasedAt) return;
      db.insert(classSummaryTable)
        .values(values)
        .onConflictDoUpdate({ target: classSummaryTable.assignmentId, set: values })
        .run();
    });
    lecturerChanged(row.courseId, row.id);
  }

  jobs.register("review.classSummary", handleClassSummary, { onFailed: runStepFailed });

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

  const api: HomeworkModule = {
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
          if (existing.releasedAt) {
            throw new DomainError("assignment.released", "This Assignment is Released, so it can't be edited.");
          }
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
      const assignment = toAssignment(row);
      const state = stateOf(row.dueAt);
      const written = mine ? reviewsOf([mine.id], assignment.criteria).get(mine.id) : undefined;
      const labels = new Map(assignment.criteria.map((c) => [c.id, c.label]));
      const summary = row.releasedAt ? readClassSummary(assignment) : null;
      const shown = summary !== null && summary.reviewCount >= MIN_CLASS_SUMMARY_REVIEWS;
      return {
        ...assignment,
        state: studentStateOf(row),
        submission: mine ? toStudentSubmission(mine, row.dueAt) : null,
        canReplace: state === "open" || !mine,
        review:
          written?.review.releasedAt
            ? { levels: written.levels.map((l) => ({ ...l, label: labels.get(l.criterionId)! })) }
            : null,
        classSummary: shown ? { counts: summary.counts, commonMistakes: summary.commonMistakes } : null,
        classSummaryHidden: summary !== null && !shown,
        help:
          row.releasedAt && written?.review.releasedAt
            ? studentHelp(row, assignment, rosterEntryId, written.levels)
            : [],
        matchDeadline: row.matchDeadline?.toISOString() ?? null,
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
          state: studentStateOf(r),
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

    release(assignmentId, matchDeadline) {
      const row = assignmentRow(assignmentId);
      if (row.releasedAt) throw new DomainError("release.done", "This Assignment is already Released.");
      const blocker = releaseBlocker(row);
      if (blocker) throw new DomainError("release.blocked", blocker);
      const now = clock.now();
      const deadline = matchDeadline ? new Date(matchDeadline) : new Date(now.getTime() + DEFAULT_MATCH_DELAY_MS);
      if (Number.isNaN(deadline.getTime()) || deadline <= now) {
        throw new DomainError("release.bad-deadline", "Pick a match deadline in the future.");
      }
      const assignment = toAssignment(row);
      db.transaction(() => {
        const reviews = reviewsOf(
          reviewedSubmissions(assignmentId).map((s) => s.id),
          assignment.criteria,
        );
        // The class summary goes out with the Reviews as they are now, Lecturer edits included.
        const previous = db.select().from(classSummaryTable).where(eq(classSummaryTable.assignmentId, assignmentId)).get();
        const levels = [...reviews.values()].map((r) => r.levels);
        const values = {
          assignmentId,
          counts: JSON.stringify({ reviewCount: levels.length, perCriterion: countLevels(assignment.criteria, levels) }),
          commonMistakes: previous?.commonMistakes ?? "[]",
          createdAt: now,
        };
        db.insert(classSummaryTable)
          .values(values)
          .onConflictDoUpdate({ target: classSummaryTable.assignmentId, set: values })
          .run();
        const reviewIds = [...reviews.values()].map((r) => r.review.id);
        if (reviewIds.length) db.update(reviewTable).set({ releasedAt: now }).where(inArray(reviewTable.id, reviewIds)).run();
        db.update(assignmentTable)
          .set({ releasedAt: now, matchDeadline: deadline })
          .where(eq(assignmentTable.id, assignmentId))
          .run();
        jobs.enqueue("help.match", { assignmentId }, deadline);
      });
      changed(row.courseId, assignmentId);
      return lecturerView(assignmentId);
    },

    releaseReview(assignmentId, submissionId) {
      const row = assignmentRow(assignmentId);
      submissionOf(assignmentId, submissionId);
      if (!row.releasedAt) {
        throw new DomainError("release.not-released", "Release the Assignment first; this Review then goes with it.");
      }
      const existing = db.select().from(reviewTable).where(eq(reviewTable.submissionId, submissionId)).get();
      if (!existing) throw new DomainError("release.no-review", "This Submission has no Review to release yet.");
      if (existing.releasedAt) throw new DomainError("release.review-done", "This Review is already released.");
      db.update(reviewTable).set({ releasedAt: clock.now() }).where(eq(reviewTable.id, existing.id)).run();
      changed(row.courseId, assignmentId);
      return lecturerView(assignmentId);
    },

    requestHelp(assignmentId, criterionId, rosterEntryId) {
      const { row, level } = helpLevel(assignmentId, criterionId, rosterEntryId);
      if (level === "secure") {
        throw new DomainError("help.secure", "You're Secure on this Criterion, so you can offer help instead.");
      }
      db.insert(helpRequest)
        .values({ criterionId, rosterEntryId, level, createdAt: clock.now() })
        .onConflictDoNothing()
        .run();
      lecturerChanged(row.courseId, assignmentId);
      return api.studentView(assignmentId, rosterEntryId);
    },

    offerHelp(assignmentId, criterionId, rosterEntryId) {
      const { row, level } = helpLevel(assignmentId, criterionId, rosterEntryId);
      if (level !== "secure") {
        throw new DomainError("help.not-secure", "You can offer help on a Criterion where you reached Secure.");
      }
      db.insert(helpOffer).values({ criterionId, rosterEntryId, createdAt: clock.now() }).onConflictDoNothing().run();
      lecturerChanged(row.courseId, assignmentId);
      return api.studentView(assignmentId, rosterEntryId);
    },

    matchNow(assignmentId) {
      const row = assignmentRow(assignmentId);
      if (!row.releasedAt) throw new DomainError("help.not-released", "Release the Assignment before matching.");
      if (row.matchedAt) throw new DomainError("help.matched", "Help matching has already run.");
      jobs.enqueue("help.match", { assignmentId });
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
  return api;
}
