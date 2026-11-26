import { and, asc, eq, lte } from "drizzle-orm";
import type { Clock } from "../clock";
import type { Db, Tx } from "../db";
import { job as jobTable } from "./schema";

/**
 * Jobs (docs/diagrams/class-diagram.md, #15, #18): a durable `job` table worked by one
 * in-process worker. A handler does its slow work first, then writes its result and marks the
 * job done in one transaction with `complete(job, tx => …)`, so a job interrupted before that
 * leaves nothing written. Attempts count at claim, 3 for every kind. On boot, `recover()` puts
 * `running` jobs back to `queued`. There is no drain on shutdown.
 */
export type JobKind =
  | "summary.generate"
  | "summary.translate"
  | "review.submission"
  | "review.compare"
  | "review.classSummary"
  | "help.match";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: number;
  kind: JobKind;
  payload: unknown;
  runAt: Date;
}

export interface JobState extends Job {
  status: JobStatus;
  attempts: number;
  progress: { done: number; total: number } | null;
  error: string | null;
}

export type JobHandler = (job: Job) => Promise<void>;

export interface Jobs {
  enqueue(kind: JobKind, payload: unknown, runAt?: Date): Job;
  register(kind: JobKind, handler: JobHandler): void;
  progress(job: Job, done: number, total: number): void;
  /** Re-queues a failed job now, with its attempts reset (the Lecturer's Retry). */
  retry(job: Job | number): void;
  /** Writes the job's result and marks it done, in one transaction. */
  complete(job: Job, write: (tx: Tx) => void): void;
  /** Ends the job failed at once, with no automatic retry (e.g. an LlmError already retried). */
  fail(job: Job, error: string): void;
  read(jobId: number): JobState;
}

/** The worker side, used by the app's startup and by tests. */
export interface JobWorker extends Jobs {
  /** At boot: `running` jobs go back to `queued`, or to `failed` once out of attempts. */
  recover(): void;
  /** Runs every job due on the Clock, one at a time, until none is due. */
  runDue(): Promise<void>;
  /** The earliest run_at among queued jobs, for the next-event timer. */
  nextRunAt(): Date | null;
  /** Starts the timer that wakes at the next run_at. */
  start(): void;
  stop(): void;
  /** Resolves when the current run (if any) finishes. */
  idle(): Promise<void>;
}

export const MAX_ATTEMPTS = 3;

/** Schedules fn after ms; returns a cancel function. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

const realTimer: SetTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/** setTimeout's limit; a later run_at is rescheduled when this fires. */
const MAX_DELAY = 2 ** 31 - 1;

export interface JobsDeps {
  db: Db;
  clock: Clock;
  setTimer?: SetTimer;
  onError?: (error: unknown, job: Job) => void;
}

export function createJobs({ db, clock, setTimer = realTimer, onError }: JobsDeps): JobWorker {
  const handlers = new Map<JobKind, JobHandler>();
  let current: Promise<void> | null = null;
  let again = false;
  let started = false;
  let cancelTimer: (() => void) | null = null;

  const toState = (row: typeof jobTable.$inferSelect): JobState => ({
    id: row.id,
    kind: row.kind as JobKind,
    payload: JSON.parse(row.payload) as unknown,
    runAt: row.runAt,
    status: row.status as JobStatus,
    attempts: row.attempts,
    progress:
      row.progressDone !== null && row.progressTotal !== null
        ? { done: row.progressDone, total: row.progressTotal }
        : null,
    error: row.error,
  });
  const toJob = ({ id, kind, payload, runAt }: JobState): Job => ({ id, kind, payload, runAt });
  const idOf = (job: Job | number) => (typeof job === "number" ? job : job.id);

  function read(jobId: number): JobState {
    const row = db.select().from(jobTable).where(eq(jobTable.id, jobId)).get();
    if (!row) throw new Error(`Job ${jobId} not found`);
    return toState(row);
  }

  function claimNext(): JobState | null {
    return db.transaction((tx) => {
      const next = tx
        .select()
        .from(jobTable)
        .where(and(eq(jobTable.status, "queued"), lte(jobTable.runAt, clock.now())))
        .orderBy(asc(jobTable.runAt), asc(jobTable.id))
        .limit(1)
        .get();
      if (!next) return null;
      const row = tx
        .update(jobTable)
        .set({ status: "running", attempts: next.attempts + 1 })
        .where(eq(jobTable.id, next.id))
        .returning()
        .get()!;
      return toState(row);
    });
  }

  function afterFailure(claimed: JobState, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const out = claimed.attempts >= MAX_ATTEMPTS;
    db.update(jobTable)
      .set({ status: out ? "failed" : "queued", error: message, runAt: clock.now() })
      .where(and(eq(jobTable.id, claimed.id), eq(jobTable.status, "running")))
      .run();
  }

  async function runOne(claimed: JobState) {
    const handler = handlers.get(claimed.kind);
    if (!handler) {
      db.update(jobTable)
        .set({ status: "failed", error: `No handler for ${claimed.kind}` })
        .where(eq(jobTable.id, claimed.id))
        .run();
      return;
    }
    const job = toJob(claimed);
    try {
      await handler(job);
      // A handler with nothing to write may return without calling complete.
      db.update(jobTable)
        .set({ status: "done", error: null })
        .where(and(eq(jobTable.id, job.id), eq(jobTable.status, "running")))
        .run();
    } catch (error) {
      onError?.(error, job);
      afterFailure(claimed, error);
    }
  }

  async function drain() {
    do {
      again = false;
      for (let next = claimNext(); next; next = claimNext()) await runOne(next);
    } while (again);
  }

  function runDue(): Promise<void> {
    if (current) {
      again = true;
      return current;
    }
    current = drain().finally(() => {
      current = null;
      if (started) schedule();
    });
    return current;
  }

  function nextRunAt(): Date | null {
    const row = db
      .select({ runAt: jobTable.runAt })
      .from(jobTable)
      .where(eq(jobTable.status, "queued"))
      .orderBy(asc(jobTable.runAt))
      .limit(1)
      .get();
    return row?.runAt ?? null;
  }

  function schedule() {
    cancelTimer?.();
    cancelTimer = null;
    if (!started || current) return;
    const at = nextRunAt();
    if (!at) return;
    const delay = Math.min(Math.max(0, at.getTime() - clock.now().getTime()), MAX_DELAY);
    cancelTimer = setTimer(() => {
      cancelTimer = null;
      void runDue();
    }, delay);
  }

  return {
    enqueue(kind, payload, runAt = clock.now()) {
      const row = db
        .insert(jobTable)
        .values({ kind, payload: JSON.stringify(payload ?? null), runAt, status: "queued" })
        .returning()
        .get();
      schedule();
      return toJob(toState(row));
    },

    register(kind, handler) {
      handlers.set(kind, handler);
    },

    progress(job, done, total) {
      db.update(jobTable).set({ progressDone: done, progressTotal: total }).where(eq(jobTable.id, job.id)).run();
    },

    retry(job) {
      db.update(jobTable)
        .set({ status: "queued", attempts: 0, error: null, runAt: clock.now() })
        .where(and(eq(jobTable.id, idOf(job)), eq(jobTable.status, "failed")))
        .run();
      schedule();
    },

    complete(job, write) {
      db.transaction((tx) => {
        write(tx);
        const done = tx
          .update(jobTable)
          .set({ status: "done", error: null })
          .where(and(eq(jobTable.id, job.id), eq(jobTable.status, "running")))
          .returning({ id: jobTable.id })
          .get();
        // Not running any more (e.g. reset by a restart): roll the result back.
        if (!done) throw new Error(`Job ${job.id} is no longer running`);
      });
    },

    fail(job, error) {
      db.update(jobTable)
        .set({ status: "failed", error })
        .where(and(eq(jobTable.id, job.id), eq(jobTable.status, "running")))
        .run();
    },

    read,

    recover() {
      db.transaction((tx) => {
        const running = tx.select().from(jobTable).where(eq(jobTable.status, "running")).all();
        for (const row of running) {
          const out = row.attempts >= MAX_ATTEMPTS;
          tx.update(jobTable)
            .set(
              out
                ? { status: "failed", error: `Interrupted ${row.attempts} times by a restart.` }
                : { status: "queued" },
            )
            .where(eq(jobTable.id, row.id))
            .run();
        }
      });
    },

    runDue,
    nextRunAt,

    start() {
      started = true;
      void runDue();
    },

    stop() {
      started = false;
      cancelTimer?.();
      cancelTimer = null;
    },

    idle: () => current ?? Promise.resolve(),
  };
}
