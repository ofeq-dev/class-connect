import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Clock } from "../clock";
import type { CourseModule } from "../course";
import type { Db } from "../db";
import { DomainError, NotFoundError } from "../errors";
import type { FileStore } from "../files";
import type { Job, Jobs } from "../jobs";
import type { LiveEvents } from "../live-events";
import type { LlmGateway } from "../llm";
import { summary, summaryTranslation, summaryVersion, transcript as transcriptTable } from "./schema";
import { draftMarkdown, summarise } from "./summarise-task";
import { NO_TIMESTAMPS_WARNING, readTranscript } from "./transcript";
import { translate } from "./translate-task";

export { NO_TIMESTAMPS_WARNING, readTranscript } from "./transcript";
/** The LLM tasks, for the fake adapter's rehearsal fixtures (validated with the same schemas). */
export { draftMarkdown, summarise, type SummariseInput } from "./summarise-task";
export { translate, type TranslateInput } from "./translate-task";

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
  /** One per Course language set when it was last published, in the Course's order. */
  translations: SummaryTranslation[];
}

export type TranslationState = "translating" | "failed" | "done";

/** A translation of the published version; edited in place, without history. */
export interface SummaryTranslation {
  language: string;
  state: TranslationState;
  /** Null until translated. */
  markdown: string | null;
  error: string | null;
  /** The Lecturer has edited it; publishing again overwrites the edit. */
  edited: boolean;
}

/** What a Student reads: the published version, or its translation. */
export interface PublishedSummary {
  sessionId: number;
  date: string;
  start: string;
  markdown: string;
  /** The translation's language, or null for the source language. */
  language: string | null;
  /** The languages a translation is ready in, besides the source. */
  languages: string[];
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
  /**
   * Makes this version the one Students see, tells their phones, and queues one
   * `summary.translate` per Course language. Publishing again replaces every translation,
   * Lecturer edits included (the console confirms first).
   */
  publish(sessionId: number, versionId: number): LecturerSummary;
  /** Overwrites a finished translation, without history. */
  saveTranslation(sessionId: number, language: string, markdown: string): LecturerSummary;
  /** Queues a failed translation again. */
  retryTranslation(sessionId: number, language: string): LecturerSummary;
  /** Removes the summary with its whole history; the Transcript stays. */
  deleteSummary(sessionId: number): void;
  /**
   * The published summary for a phone with a Claim on the Session's Course, else null: in
   * `language` when that translation is ready (an exact code, else its base, so ar-EG finds ar),
   * otherwise the source language.
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

  const translationRows = (summaryId: number) =>
    db
      .select()
      .from(summaryTranslation)
      .where(eq(summaryTranslation.summaryId, summaryId))
      .orderBy(asc(summaryTranslation.id)) // inserted in the Course's language order
      .all();

  function toTranslation(row: typeof summaryTranslation.$inferSelect): SummaryTranslation {
    const job = jobs.read(row.jobId);
    const base = { language: row.language, markdown: row.markdown, edited: row.editedAt !== null };
    if (row.markdown !== null) return { ...base, state: "done", error: null };
    if (job.status === "failed") return { ...base, state: "failed", error: job.error };
    return { ...base, state: "translating", error: null };
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
      translations: row ? translationRows(row.id).map(toTranslation) : [],
    };
  }

  /** This Session's translation into the language, or a refusal. */
  function translationOf(sessionId: number, language: string) {
    const row = summaryRow(sessionId);
    const tr = row
      ? db
          .select()
          .from(summaryTranslation)
          .where(and(eq(summaryTranslation.summaryId, row.id), eq(summaryTranslation.language, language)))
          .get()
      : undefined;
    if (!tr) throw new DomainError("summary.unknown-translation", "There's no translation into that language.");
    return tr;
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

  async function handleTranslate(job: Job) {
    const { sessionId, language } = job.payload as { sessionId: number; language: string };
    const row = summaryRow(sessionId);
    const tr = row
      ? db
          .select()
          .from(summaryTranslation)
          .where(and(eq(summaryTranslation.summaryId, row.id), eq(summaryTranslation.language, language)))
          .get()
      : undefined;
    // Published again, or deleted, since this job was queued: a newer job (or none) owns the row.
    if (!tr || tr.jobId !== job.id) return;
    const source = db.select().from(summaryVersion).where(eq(summaryVersion.id, tr.sourceVersionId)).get();
    if (!source) return jobs.fail(job, "The published version is gone.");

    const result = await llm.generate(translate(source.markdown), { markdown: source.markdown, language });
    if (!result.ok) {
      jobs.fail(job, result.error.message);
      changed(sessionId);
      return;
    }
    jobs.complete(job, (tx) =>
      tx
        .update(summaryTranslation)
        .set({ markdown: result.value.markdown, editedAt: null })
        .where(and(eq(summaryTranslation.id, tr.id), eq(summaryTranslation.jobId, job.id)))
        .run(),
    );
    changed(sessionId, "all");
  }

  jobs.register("summary.generate", handleGenerate);
  jobs.register("summary.translate", handleTranslate);

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
      const { courseId } = course.readSession(sessionId);
      const languages = course.translationLanguages(courseId);
      db.transaction((tx) => {
        tx.update(summary).set({ publishedVersionId: version.id }).where(eq(summary.id, row.id)).run();
        // Every translation is made afresh from this version; earlier jobs find their row gone.
        tx.delete(summaryTranslation).where(eq(summaryTranslation.summaryId, row.id)).run();
        for (const language of languages) {
          const job = jobs.enqueue("summary.translate", { sessionId, language });
          tx.insert(summaryTranslation)
            .values({ summaryId: row.id, language, sourceVersionId: version.id, jobId: job.id })
            .run();
        }
      });
      changed(sessionId, "all");
      return forLecturer(sessionId);
    },

    saveTranslation(sessionId, language, markdown) {
      if (!markdown.trim()) throw new DomainError("summary.empty", "The translation can't be empty.");
      const tr = translationOf(sessionId, language);
      if (tr.markdown === null) {
        throw new DomainError("summary.translation-not-ready", "Wait for the translation to finish first.");
      }
      db.update(summaryTranslation)
        .set({ markdown, editedAt: clock.now() })
        .where(eq(summaryTranslation.id, tr.id))
        .run();
      changed(sessionId, "all");
      return forLecturer(sessionId);
    },

    retryTranslation(sessionId, language) {
      const tr = translationOf(sessionId, language);
      if (jobs.read(tr.jobId).status !== "failed") {
        throw new DomainError("summary.nothing-to-retry", "That translation hasn't failed.");
      }
      jobs.retry(tr.jobId);
      changed(sessionId);
      return forLecturer(sessionId);
    },

    deleteSummary(sessionId) {
      const row = summaryRow(sessionId);
      if (!row) return;
      db.delete(summary).where(eq(summary.id, row.id)).run(); // versions go with it (on delete cascade)
      changed(sessionId, row.publishedVersionId ? "all" : "lecturer");
    },

    forStudent(deviceToken, sessionId, language) {
      const session = studentSession(deviceToken, sessionId);
      const row = session && summaryRow(sessionId);
      if (!session || !row?.publishedVersionId) return null;
      const version = db.select().from(summaryVersion).where(eq(summaryVersion.id, row.publishedVersionId)).get();
      if (!version) return null;
      const ready = translationRows(row.id).filter((t) => t.markdown !== null);
      const wanted = language?.trim().toLowerCase();
      const chosen = wanted
        ? (ready.find((t) => t.language.toLowerCase() === wanted) ??
          ready.find((t) => t.language.toLowerCase() === wanted.split("-")[0]))
        : undefined;
      return {
        sessionId,
        date: session.date,
        start: session.start,
        markdown: chosen?.markdown ?? version.markdown,
        language: chosen?.language ?? null,
        languages: ready.map((t) => t.language),
      };
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
