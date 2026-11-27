import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// course_id and roster_entry_id refer to Course's tables; Course owns them, so there is no
// cross-module foreign key. Job ids refer to Jobs' table the same way.

export const assignment = sqliteTable(
  "assignment",
  {
    id: integer("id").primaryKey(),
    courseId: integer("course_id").notNull(),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    dueAt: integer("due_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** Set once by Release: every Review and the class summary go out, and Help opens. */
    releasedAt: integer("released_at", { mode: "timestamp_ms" }),
    /** When help.match runs unless the Lecturer matches first. */
    matchDeadline: integer("match_deadline", { mode: "timestamp_ms" }),
    /** Set by the one Help matching pass; after it no Help request or offer is taken. */
    matchedAt: integer("matched_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("assignment_course").on(t.courseId)],
);

export const criterion = sqliteTable(
  "criterion",
  {
    id: integer("id").primaryKey(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => assignment.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** 0-based order within the Assignment. */
    position: integer("position").notNull(),
  },
  (t) => [index("criterion_assignment").on(t.assignmentId, t.position)],
);

/** One per Student per Assignment; a replacement overwrites it. Late is worked out from submitted_at and due_at. */
export const submission = sqliteTable(
  "submission",
  {
    id: integer("id").primaryKey(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => assignment.id, { onDelete: "cascade" }),
    rosterEntryId: integer("roster_entry_id").notNull(),
    /** Pasted text, or the text extracted from the PDF. */
    text: text("text").notNull(),
    /** The PDF in the File store; null for pasted text. */
    fileHash: text("file_hash"),
    fileName: text("file_name"),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("submission_assignment_student").on(t.assignmentId, t.rosterEntryId)],
);

/** One press of Start review run: the Submissions it drafts, then compare, then the class summary. */
export const reviewRun = sqliteTable(
  "review_run",
  {
    id: integer("id").primaryKey(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => assignment.id, { onDelete: "cascade" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    /** The latest review.compare job, once the run's drafts have settled. */
    compareJobId: integer("compare_job_id"),
    /** The latest review.classSummary job, queued by compare. */
    classSummaryJobId: integer("class_summary_job_id"),
  },
  (t) => [index("review_run_assignment").on(t.assignmentId)],
);

/** A Submission's review.submission job within a run; progress is counted from these jobs' rows. */
export const reviewJob = sqliteTable(
  "review_job",
  {
    id: integer("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => reviewRun.id, { onDelete: "cascade" }),
    submissionId: integer("submission_id")
      .notNull()
      .references(() => submission.id, { onDelete: "cascade" }),
    jobId: integer("job_id").notNull(),
  },
  (t) => [index("review_job_run").on(t.runId), index("review_job_submission").on(t.submissionId)],
);

/** At most one per Submission: drafted by the AI or written by hand, editable by the Lecturer. */
export const review = sqliteTable("review", {
  id: integer("id").primaryKey(),
  submissionId: integer("submission_id")
    .notNull()
    .unique()
    .references(() => submission.id, { onDelete: "cascade" }),
  /** ai | lecturer: who wrote the first version. */
  author: text("author").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  editedAt: integer("edited_at", { mode: "timestamp_ms" }),
  releasedAt: integer("released_at", { mode: "timestamp_ms" }),
});

/** One per Criterion of a Review. There is no overall mark. */
export const reviewLevel = sqliteTable(
  "review_level",
  {
    reviewId: integer("review_id")
      .notNull()
      .references(() => review.id, { onDelete: "cascade" }),
    criterionId: integer("criterion_id")
      .notNull()
      .references(() => criterion.id, { onDelete: "cascade" }),
    /** not-yet | partly | secure */
    level: text("level").notNull(),
    evidence: text("evidence").notNull(),
    feedback: text("feedback").notNull(),
  },
  (t) => [primaryKey({ columns: [t.reviewId, t.criterionId] })],
);

/** Anonymised: counts per Criterion and common mistakes, never names or text. */
export const classSummary = sqliteTable("class_summary", {
  assignmentId: integer("assignment_id")
    .primaryKey()
    .references(() => assignment.id, { onDelete: "cascade" }),
  /** JSON: [{criterionId, notYet, partly, secure}]. */
  counts: text("counts").notNull(),
  /** JSON: string[]. */
  commonMistakes: text("common_mistakes").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** For the Lecturer only: never read by a Student read model. Changes no level. */
export const similarityPair = sqliteTable(
  "similarity_pair",
  {
    id: integer("id").primaryKey(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => assignment.id, { onDelete: "cascade" }),
    /** The lower Submission id of the two. */
    submissionAId: integer("submission_a_id")
      .notNull()
      .references(() => submission.id, { onDelete: "cascade" }),
    submissionBId: integer("submission_b_id")
      .notNull()
      .references(() => submission.id, { onDelete: "cascade" }),
    score: real("score").notNull(),
    fingerprintOverlap: real("fingerprint_overlap").notNull(),
    /** Null when the embedding call failed on its last attempt. */
    embeddingSimilarity: real("embedding_similarity"),
    /** JSON: [{a: string, b: string}], the overlapping passages side by side. */
    passages: text("passages").notNull(),
  },
  (t) => [index("similarity_pair_assignment").on(t.assignmentId)],
);

/** A Student at Not yet or Partly on a Criterion asking for help, after Release. */
export const helpRequest = sqliteTable(
  "help_request",
  {
    id: integer("id").primaryKey(),
    criterionId: integer("criterion_id")
      .notNull()
      .references(() => criterion.id, { onDelete: "cascade" }),
    rosterEntryId: integer("roster_entry_id").notNull(),
    /** The level the Student reached when asking: not-yet | partly. Not yet is matched first. */
    level: text("level").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("help_request_criterion_student").on(t.criterionId, t.rosterEntryId)],
);

/** A Student at Secure on a Criterion offering to be a Helper, after Release. */
export const helpOffer = sqliteTable(
  "help_offer",
  {
    id: integer("id").primaryKey(),
    criterionId: integer("criterion_id")
      .notNull()
      .references(() => criterion.id, { onDelete: "cascade" }),
    rosterEntryId: integer("roster_entry_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("help_offer_criterion_student").on(t.criterionId, t.rosterEntryId)],
);

/** A Help request paired with a Helper's offer: at most one per request, at most two per offer. */
export const helpMatch = sqliteTable(
  "help_match",
  {
    helpRequestId: integer("help_request_id")
      .primaryKey()
      .references(() => helpRequest.id, { onDelete: "cascade" }),
    helpOfferId: integer("help_offer_id")
      .notNull()
      .references(() => helpOffer.id, { onDelete: "cascade" }),
  },
  (t) => [index("help_match_offer").on(t.helpOfferId)],
);
