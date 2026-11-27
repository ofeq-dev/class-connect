import { eq } from "drizzle-orm";
import type { Clock } from "../clock";
import type { Db } from "../db";
import type { Job, Jobs } from "../jobs";
import type { LlmGateway } from "../llm";
import { classSummary as classSummaryTask } from "./class-summary-task";
import type { Criterion, ReviewLevel } from "./index";
import { reviewSubmission } from "./review-task";
import {
  assignment as assignmentTable,
  classSummary as classSummaryTable,
  review as reviewTable,
  reviewRun,
  similarityPair,
  submission as submissionTable,
} from "./schema";
import { compareFingerprints, cosine, fingerprint, SIMILARITY_THRESHOLD, similarityScore } from "./similarity";

/** What the review run's jobs read from the rest of the Homework module. */
export interface ReviewRunContext {
  db: Db;
  clock: Clock;
  llm: LlmGateway;
  jobs: Jobs;
  assignmentRow(assignmentId: number): typeof assignmentTable.$inferSelect;
  criteriaOf(assignmentId: number): Criterion[];
  runJobIds(runId: number): number[];
  reviewsOf(
    submissionIds: number[],
    criteria: Criterion[],
  ): Map<number, { review: typeof reviewTable.$inferSelect; levels: ReviewLevel[] }>;
  countLevels(
    criteria: Criterion[],
    reviews: ReviewLevel[][],
  ): { criterionId: number; notYet: number; partly: number; secure: number }[];
  reviewedSubmissions(assignmentId: number): { id: number; text: string }[];
  writeReview(submissionId: number, levels: ReviewLevel[], author: "ai" | "lecturer"): void;
  publishProgress(courseId: number, assignmentId: number, runId: number): void;
  lecturerChanged(courseId: number, assignmentId: number): void;
}

/**
 * The review run's job handlers: `review.submission` drafts one Review, the run's last settled
 * draft queues `review.compare` (fingerprints plus one batched embedding call), which queues
 * `review.classSummary`.
 */
export function registerReviewRunJobs(ctx: ReviewRunContext) {
  const {
    db,
    clock,
    llm,
    jobs,
    assignmentRow,
    criteriaOf,
    runJobIds,
    reviewsOf,
    countLevels,
    reviewedSubmissions,
    writeReview,
    publishProgress,
    lecturerChanged,
  } = ctx;

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
}
