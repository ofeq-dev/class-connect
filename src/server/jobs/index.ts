/**
 * Jobs seam (docs/diagrams/class-diagram.md). Only the interface exists so far; the durable
 * job table and its worker arrive with the Session summary work (#32).
 */
export type JobKind =
  | "summary.generate"
  | "summary.translate"
  | "review.submission"
  | "review.compare"
  | "review.classSummary"
  | "help.match";

export interface Job {
  id: number;
  kind: JobKind;
  payload: unknown;
  runAt: Date;
}

export interface Jobs {
  enqueue(kind: JobKind, payload: unknown, runAt?: Date): Job;
  register(kind: JobKind, handler: (job: Job) => Promise<void>): void;
  progress(job: Job, done: number, total: number): void;
  retry(job: Job): void;
}
