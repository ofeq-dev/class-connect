import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** The durable job queue, worked by one in-process worker (docs/diagrams/class-diagram.md). */
export const job = sqliteTable(
  "job",
  {
    id: integer("id").primaryKey(),
    kind: text("kind").notNull(),
    /** JSON. */
    payload: text("payload").notNull(),
    runAt: integer("run_at", { mode: "timestamp_ms" }).notNull(),
    /** queued | running | done | failed */
    status: text("status").notNull(),
    /** Counted when the worker claims the job, so an interrupted run still counts. */
    attempts: integer("attempts").notNull().default(0),
    progressDone: integer("progress_done"),
    progressTotal: integer("progress_total"),
    error: text("error"),
  },
  (t) => [index("job_status_run_at").on(t.status, t.runAt)],
);
