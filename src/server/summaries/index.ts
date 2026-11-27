import { and, desc, eq, inArray } from "drizzle-orm";
import type { Clock } from "../clock";
import type { CourseModule } from "../course";
import type { Db } from "../db";
import { DomainError, NotFoundError } from "../errors";
import type { FileStore } from "../files";
import type { Job, Jobs } from "../jobs";
import type { LiveEvents } from "../live-events";
import type { LlmGateway } from "../llm";
import { summary, summaryVersion, transcript as transcriptTable } from "./schema";
import { draftMarkdown, summarise } from "./summarise-task";
import { NO_TIMESTAMPS_WARNING, readTranscript } from "./transcript";

export { NO_TIMESTAMPS_WARNING } from "./transcript";

export interface Transcript {
  text: string;
  hasTimestamps: boolean;
  fileName: string | null;
  fileHash: string | null;
  uploadedAt: string;
}

export interface SummaryVersion {
  id: number;
  number: number;
  author: "ai" | "lecturer";
  markdown: string;
  createdAt: string;
}

/**
 * no-transcript → ready (a Transcript, nothing generated) → summarising → draft, or failed
 * (with the error and Retry) → published once a version is published. A failed regenerate
 * keeps the earlier versions.
 */
export type SummaryState = "no-transcript" | "ready" | "summarising" | "failed" | "draft" | "published";

export interface LecturerSummary {
  sessionId: number;
  transcript: Transcript | null;
  state: SummaryState;
  error: string | null;
  /** Newest first. */
  versions: SummaryVersion[];
  /** The version Students see, or null before publishing. */
  publishedVersionId: number | null;
}

/** What a Student reads: the published version only. Translations come with #34. */
export interface PublishedSummary {
  sessionId: number;
  date: string;
  start: string;
  markdown: string;
}

export interface PublishedSummaryRow {
  sessionId: number;
  date: string;
  start: string;
}

export interface SummaryRow {
  sessionId: number;
  state: SummaryState;
  error: string | null;
}

export interface SummariesModule {
  /** A `.vtt` / `.txt` file (fileName given) or pasted text. Replaces any earlier Transcript. */
  uploadTranscript(
    sessionId: number,
    input: { text: string; fileName?: string | null },
  ): Promise<{ transcript: Transcript; warning: string | null }>;
  /** Queues `summary.generate`. Regenerating adds a version; it never overwrites one. */
  generate(sessionId: number): LecturerSummary;
  /** Queues the failed generation again. */
  retry(sessionId: number): LecturerSummary;
  forLecturer(sessionId: number): LecturerSummary;
  /** A new version by the Lecturer. Students keep seeing the published version. */
  saveEdit(sessionId: number, markdown: string): LecturerSummary;
  /** Copies an old version of this Session's summary as the newest, by the Lecturer. */
  restore(sessionId: number, versionId: number): LecturerSummary;
  /** Makes this version the one Students see, and tells their phones. */
  publish(sessionId: number, versionId: number): LecturerSummary;
  /** Removes the summary with its whole history; the Transcript stays. */
  deleteSummary(sessionId: number): void;
  /**
   * The published summary for a phone with a Claim on the Session's Course, else null.
   * `language` is accepted for the translations ticket; for now the source is returned.
   */
  forStudent(deviceToken: string | undefined, sessionId: number, language?: string): PublishedSummary | null;
  /** The published summaries of the phone's Course, newest Session first; empty when unclaimed. */
  listForStudent(deviceToken: string | undefined): PublishedSummaryRow[];
  /** One row per Session of the Course, for the Course desk. */
  forCourse(courseId: number): SummaryRow[];
}

export interface SummariesDeps {
  db: Db;
  clock: Clock;
  course: CourseModule;
  llm: LlmGateway;
  jobs: Jobs;
  files: FileStore;
  events: LiveEvents;
}

export function createSummariesModule({ db, clock, course, llm, jobs, files, events }: SummariesDeps): SummariesModule {
  /** Drafts are the Lecturer's business; what Students read changes only on publish or delete. */
  const changed = (sessionId: number, audience: "lecturer" | "all" = "lecturer") => {
    const { courseId } = course.readSession(sessionId);
    events.publish(courseId, audience, { type: "summary.changed", id: sessionId });
  };

  const toTranscript = (row: typeof transcriptTable.$inferSelect): Transcript => ({
    text: row.text,
    hasTimestamps: row.hasTimestamps,
    fileName: row.fileName,
    fileHash: row.fileHash,
    uploadedAt: row.uploadedAt.toISOString(),
  });

  const transcriptRow = (sessionId: number) =>
    db.select().from(transcriptTable).where(eq(transcriptTable.sessionId, sessionId)).get();
  const summaryRow = (sessionId: number) => db.select().from(summary).where(eq(summary.sessionId, sessionId)).get();

  function generation(row: typeof summary.$inferSelect | undefined) {
    if (!row?.generationJobId) return null;
    return jobs.read(row.generationJobId);
  }

  function state(
    hasTranscript: boolean,
    row: typeof summary.$inferSelect | undefined,
    versionCount: number,
  ): { state: SummaryState; error: string | null } {
    const job = generation(row);
    if (job?.status === "queued" || job?.status === "running") return { state: "summarising", error: null };
    if (job?.status === "failed") return { state: "failed", error: job.error };
    if (row?.publishedVersionId) return { state: "published", error: null };
    if (versionCount > 0) return { state: "draft", error: null };
    return { state: hasTranscript ? "ready" : "no-transcript", error: null };
  }

  function forLecturer(sessionId: number): LecturerSummary {
    course.readSession(sessionId);
    const t = transcriptRow(sessionId);
    const row = summaryRow(sessionId);
    const versions = row
      ? db
          .select()
          .from(summaryVersion)
          .where(eq(summaryVersion.summaryId, row.id))
          .orderBy(desc(summaryVersion.number))
          .all()
          .map((v) => ({
            id: v.id,
            number: v.number,
            author: v.author as SummaryVersion["author"],
            markdown: v.markdown,
            createdAt: v.createdAt.toISOString(),
          }))
      : [];
    return {
      sessionId,
      transcript: t ? toTranscript(t) : null,
      ...state(!!t, row, versions.length),
      versions,
      publishedVersionId: row?.publishedVersionId ?? null,
    };
  }

  /** The Session's summary row, made on first need (a Lecturer may write one by hand). */
  function ensureSummary(sessionId: number) {
    course.readSession(sessionId);
    return (
      summaryRow(sessionId) ??
      db.insert(summary).values({ sessionId }).returning().get()
    );
  }

  function addVersion(tx: Pick<Db, "select" | "insert">, summaryId: number, markdown: string, author: "ai" | "lecturer") {
    const last = tx
      .select({ number: summaryVersion.number })
      .from(summaryVersion)
      .where(eq(summaryVersion.summaryId, summaryId))
      .orderBy(desc(summaryVersion.number))
      .limit(1)
      .get();
    tx.insert(summaryVersion)
      .values({ summaryId, number: (last?.number ?? 0) + 1, markdown, author, createdAt: clock.now() })
      .run();
  }

  /** A version of this Session's summary, or a refusal. */
  function versionOf(sessionId: number, versionId: number) {
    const row = summaryRow(sessionId);
    const version = row
      ? db
          .select()
          .from(summaryVersion)
          .where(and(eq(summaryVersion.id, versionId), eq(summaryVersion.summaryId, row.id)))
          .get()
      : undefined;
    if (!row || !version) {
      throw new DomainError("summary.unknown-version", "That version isn't part of this Session's summary.");
    }
    return { row, version };
  }

  /** The Session, when this phone has a Claim on its Course. */
  function studentSession(deviceToken: string | undefined, sessionId: number) {
    let session;
    try {
      session = course.readSession(sessionId);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
    return course.whoIs(deviceToken, session.courseId) ? session : null;
  }

  async function handleGenerate(job: Job) {
    const { sessionId } = job.payload as { sessionId: number };
    const t = transcriptRow(sessionId);
    const row = summaryRow(sessionId);
    if (!t || !row) return jobs.fail(job, "The Transcript is gone.");

    // The slow work happens before anything is written.
    const result = await llm.generate(summarise, { transcript: t.text, hasTimestamps: t.hasTimestamps });
    if (!result.ok) {
      jobs.fail(job, result.error.message);
    } else {
      const markdown = draftMarkdown(result.value, t.hasTimestamps);
      jobs.complete(job, (tx) => addVersion(tx, row.id, markdown, "ai"));
    }
    changed(sessionId);
  }

  jobs.register("summary.generate", handleGenerate);

  return {
    async uploadTranscript(sessionId, input) {
      course.readSession(sessionId);
      const read = readTranscript(input);
      const fileName = input.fileName?.trim() || null;
      const fileHash = fileName ? await files.put(new TextEncoder().encode(input.text)) : null;
      const values = { sessionId, fileHash, fileName, ...read, uploadedAt: clock.now() };
      const row = db
        .insert(transcriptTable)
        .values(values)
        .onConflictDoUpdate({ target: transcriptTable.sessionId, set: values })
        .returning()
        .get();
      changed(sessionId);
      return { transcript: toTranscript(row), warning: read.hasTimestamps ? null : NO_TIMESTAMPS_WARNING };
    },

    generate(sessionId) {
      const view = forLecturer(sessionId);
      if (!view.transcript) throw new DomainError("summary.no-transcript", "Upload a Transcript first.");
      if (view.state === "summarising") throw new DomainError("summary.busy", "Already summarising this Session.");
      const job = jobs.enqueue("summary.generate", { sessionId });
      db.insert(summary)
        .values({ sessionId, generationJobId: job.id })
        .onConflictDoUpdate({ target: summary.sessionId, set: { generationJobId: job.id } })
        .run();
      changed(sessionId);
      return forLecturer(sessionId);
    },

    retry(sessionId) {
      const row = summaryRow(sessionId);
      if (generation(row)?.status !== "failed") {
        throw new DomainError("summary.nothing-to-retry", "There's no failed summary to retry.");
      }
      jobs.retry(row!.generationJobId!);
      changed(sessionId);
      return forLecturer(sessionId);
    },

    forLecturer,

    saveEdit(sessionId, markdown) {
      if (!markdown.trim()) throw new DomainError("summary.empty", "The summary can't be empty.");
      addVersion(db, ensureSummary(sessionId).id, markdown, "lecturer");
      changed(sessionId);
      return forLecturer(sessionId);
    },

    restore(sessionId, versionId) {
      const { row, version } = versionOf(sessionId, versionId);
      addVersion(db, row.id, version.markdown, "lecturer");
      changed(sessionId);
      return forLecturer(sessionId);
    },

    publish(sessionId, versionId) {
      const { row, version } = versionOf(sessionId, versionId);
      db.update(summary).set({ publishedVersionId: version.id }).where(eq(summary.id, row.id)).run();
      changed(sessionId, "all");
      return forLecturer(sessionId);
    },

    deleteSummary(sessionId) {
      const row = summaryRow(sessionId);
      if (!row) return;
      db.delete(summary).where(eq(summary.id, row.id)).run(); // versions go with it (on delete cascade)
      changed(sessionId, row.publishedVersionId ? "all" : "lecturer");
    },

    forStudent(deviceToken, sessionId) {
      const session = studentSession(deviceToken, sessionId);
      const row = session && summaryRow(sessionId);
      if (!session || !row?.publishedVersionId) return null;
      const version = db.select().from(summaryVersion).where(eq(summaryVersion.id, row.publishedVersionId)).get();
      if (!version) return null;
      return { sessionId, date: session.date, start: session.start, markdown: version.markdown };
    },

    listForStudent(deviceToken) {
      const viewer = course.whoIs(deviceToken);
      if (!viewer) return [];
      const sessions = course.listSessions(viewer.course.id);
      if (sessions.length === 0) return [];
      const published = new Set(
        db
          .select({ sessionId: summary.sessionId, publishedVersionId: summary.publishedVersionId })
          .from(summary)
          .where(inArray(summary.sessionId, sessions.map((s) => s.id)))
          .all()
          .filter((r) => r.publishedVersionId !== null)
          .map((r) => r.sessionId),
      );
      return sessions
        .filter((s) => published.has(s.id))
        .reverse() // listSessions is oldest first
        .map((s) => ({ sessionId: s.id, date: s.date, start: s.start }));
    },

    forCourse(courseId) {
      const sessions = course.listSessions(courseId);
      const ids = sessions.map((s) => s.id);
      if (ids.length === 0) return [];
      const withTranscript = new Set(
        db
          .select({ sessionId: transcriptTable.sessionId })
          .from(transcriptTable)
          .where(inArray(transcriptTable.sessionId, ids))
          .all()
          .map((r) => r.sessionId),
      );
      const rows = new Map(
        db.select().from(summary).where(inArray(summary.sessionId, ids)).all().map((r) => [r.sessionId, r]),
      );
      const counts = new Map<number, number>();
      const summaryIds = [...rows.values()].map((r) => r.id);
      if (summaryIds.length) {
        for (const v of db
          .select({ summaryId: summaryVersion.summaryId })
          .from(summaryVersion)
          .where(inArray(summaryVersion.summaryId, summaryIds))
          .all()) {
          counts.set(v.summaryId, (counts.get(v.summaryId) ?? 0) + 1);
        }
      }
      return sessions.map((s) => {
        const row = rows.get(s.id);
        return { sessionId: s.id, ...state(withTranscript.has(s.id), row, row ? (counts.get(row.id) ?? 0) : 0) };
      });
    },
  };
}
