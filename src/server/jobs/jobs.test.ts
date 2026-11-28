/* eslint-disable local/no-raw-sql-in-tests -- a test-only `test_result` table proves a handler's write commits with the job; it is no module's table. */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenedDatabase } from "../db";
import { FakeClock } from "../testing";
import { createJobs, type Job, type JobWorker } from ".";

let database: OpenedDatabase;
let clock: FakeClock;
let jobs: JobWorker;

/** A table only these tests write to, standing in for a feature module's result. */
function results(): string[] {
  return (database.sqlite.prepare("select value from test_result order by id").all() as { value: string }[]).map(
    (r) => r.value,
  );
}

/** A new worker over the same database, as after a process restart. */
function restart(): JobWorker {
  jobs = createJobs({ db: database.db, clock });
  jobs.recover();
  return jobs;
}

beforeEach(() => {
  database = openDatabase(":memory:", path.resolve(process.cwd(), "drizzle"));
  database.sqlite.exec("create table test_result (id integer primary key, value text not null)");
  clock = new FakeClock();
  jobs = createJobs({ db: database.db, clock });
});
afterEach(() => database.close());

const writeResult = (job: Job, value: string) =>
  jobs.complete(job, (tx) => {
    tx.run(`insert into test_result (value) values ('${value}')`);
  });

describe("Jobs", () => {
  it("runs a job at or after its run_at, never before", async () => {
    const ran: unknown[] = [];
    jobs.register("summary.generate", async (job) => {
      ran.push(job.payload);
      jobs.complete(job, () => {});
    });
    const job = jobs.enqueue("summary.generate", { sessionId: 7 }, new Date(clock.now().getTime() + 60_000));

    await jobs.runDue();
    expect(ran).toEqual([]);
    expect(jobs.read(job.id).status).toBe("queued");

    clock.advance(60_000);
    await jobs.runDue();
    expect(ran).toEqual([{ sessionId: 7 }]);
    expect(jobs.read(job.id).status).toBe("done");
  });

  it("runs due jobs in run_at order, one at a time", async () => {
    const ran: string[] = [];
    let running = 0;
    jobs.register("summary.generate", async (job) => {
      running++;
      expect(running).toBe(1);
      await new Promise((r) => setTimeout(r, 1));
      ran.push(String(job.payload.sessionId));
      running--;
      jobs.complete(job, () => {});
    });
    const now = clock.now().getTime();
    jobs.enqueue("summary.generate", { sessionId: 2 }, new Date(now - 1000));
    jobs.enqueue("summary.generate", { sessionId: 1 }, new Date(now - 2000));
    jobs.enqueue("summary.generate", { sessionId: 3 });
    await jobs.runDue();
    expect(ran).toEqual(["1", "2", "3"]);
  });

  it("tells the timer when the next queued job is due", () => {
    expect(jobs.nextRunAt()).toBeNull();
    const later = new Date(clock.now().getTime() + 5 * 60_000);
    const sooner = new Date(clock.now().getTime() + 60_000);
    jobs.enqueue("help.match", { assignmentId: 1 }, later);
    jobs.enqueue("help.match", { assignmentId: 1 }, sooner);
    expect(jobs.nextRunAt()).toEqual(sooner);
  });

  it("retries a failing job up to 3 attempts, recording the error, then leaves it failed", async () => {
    let calls = 0;
    jobs.register("summary.generate", async () => {
      calls++;
      throw new Error(`boom ${calls}`);
    });
    const job = jobs.enqueue("summary.generate", { sessionId: 1 });

    await jobs.runDue();
    expect(calls).toBe(3);
    expect(jobs.read(job.id)).toMatchObject({ status: "failed", attempts: 3, error: "boom 3" });

    await jobs.runDue();
    expect(calls).toBe(3);
  });

  it("records the error and re-queues between attempts", async () => {
    let calls = 0;
    jobs.register("summary.generate", async (job) => {
      calls++;
      if (calls === 1) throw new Error("flaky");
      expect(jobs.read(job.id)).toMatchObject({ status: "running", attempts: 2, error: "flaky" });
      writeResult(job, "ok");
    });
    const job = jobs.enqueue("summary.generate", { sessionId: 1 });
    await jobs.runDue();
    expect(jobs.read(job.id)).toMatchObject({ status: "done", attempts: 2, error: null });
    expect(results()).toEqual(["ok"]);
  });

  it("fails a job at once when its handler says so, without retrying", async () => {
    let calls = 0;
    jobs.register("summary.generate", async (job) => {
      calls++;
      jobs.fail(job, "Every model failed.");
    });
    const job = jobs.enqueue("summary.generate", { sessionId: 1 });
    await jobs.runDue();
    expect(calls).toBe(1);
    expect(jobs.read(job.id)).toMatchObject({ status: "failed", error: "Every model failed." });
  });

  it("tells the handler which attempt it is on, so it can act on its last one", async () => {
    const seen: number[] = [];
    jobs.register("review.submission", async (job) => {
      seen.push(job.attempts);
      throw new Error("again");
    });
    jobs.enqueue("review.submission", { runId: 1, submissionId: 1 });
    await jobs.runDue();
    expect(seen).toEqual([1, 2, 3]);
  });

  it("tells the handler when it is on its last attempt", async () => {
    const seen: boolean[] = [];
    jobs.register("review.compare", async (job) => {
      seen.push(job.lastAttempt);
      throw new Error("again");
    });
    jobs.enqueue("review.compare", { runId: 1 });
    await jobs.runDue();
    expect(seen).toEqual([false, false, true]);
  });

  it("runs the kind's onFailed in the transaction that fails the job for good, after the last attempt or on fail", async () => {
    const failed: string[] = [];
    const onFailed = (job: Job, error: string) => {
      failed.push(`${job.kind}: ${error} (${jobs.read(job.id).status})`);
      database.sqlite.prepare("insert into test_result (value) values (?)").run(error);
    };
    jobs.register(
      "review.submission",
      async () => {
        throw new Error("flaky");
      },
      { onFailed },
    );
    jobs.register("review.compare", async (job) => jobs.fail(job, "Out of attempts."), { onFailed });
    jobs.enqueue("review.submission", { runId: 1, submissionId: 1 });
    jobs.enqueue("review.compare", { runId: 1 });
    await jobs.runDue();
    expect(failed).toEqual(["review.submission: flaky (failed)", "review.compare: Out of attempts. (failed)"]);
    expect(results()).toEqual(["flaky", "Out of attempts."]);
  });

  it("still fails the job, with nothing written, when onFailed throws", async () => {
    jobs.register(
      "review.compare",
      async () => {
        throw new Error("boom");
      },
      {
        onFailed: () => {
          database.sqlite.prepare("insert into test_result (value) values ('half')").run();
          throw new Error("write broke");
        },
      },
    );
    const broken = jobs.enqueue("review.compare", { runId: 1 });
    await jobs.runDue();
    expect(results()).toEqual([]);
    expect(jobs.read(broken.id)).toMatchObject({ status: "failed", error: "write broke" });
  });

  it("tallies a set of jobs by status, from the job rows", async () => {
    jobs.register("review.submission", async (job) => {
      const n = job.payload.submissionId;
      if (n === 2) return jobs.fail(job, "nope");
      jobs.complete(job, () => {});
    });
    const ids = [1, 2, 3].map((n) => jobs.enqueue("review.submission", { runId: 1, submissionId: n }).id);
    const later = jobs.enqueue("review.submission", { runId: 1, submissionId: 4 }, new Date(clock.now().getTime() + 60_000));
    expect(jobs.tally([...ids, later.id])).toEqual({ queued: 4, running: 0, done: 0, failed: 0, total: 4 });
    await jobs.runDue();
    expect(jobs.tally([...ids, later.id])).toEqual({ queued: 1, running: 0, done: 2, failed: 1, total: 4 });
    expect(jobs.tally([])).toEqual({ queued: 0, running: 0, done: 0, failed: 0, total: 0 });
  });

  it("retry re-queues a failed job with fresh attempts", async () => {
    let fail = true;
    jobs.register("summary.generate", async (job) => {
      if (fail) return jobs.fail(job, "nope");
      writeResult(job, "second time");
    });
    const job = jobs.enqueue("summary.generate", { sessionId: 1 });
    await jobs.runDue();
    expect(jobs.read(job.id).status).toBe("failed");

    fail = false;
    jobs.retry(job);
    expect(jobs.read(job.id)).toMatchObject({ status: "queued", attempts: 0, error: null });
    await jobs.runDue();
    expect(jobs.read(job.id).status).toBe("done");
    expect(results()).toEqual(["second time"]);
  });

  it("discards the jobs that match, whatever their status, so none of them runs", async () => {
    const ran: unknown[] = [];
    jobs.register("summary.generate", async (job) => {
      ran.push(job.payload);
      jobs.complete(job, () => {});
    });
    const done = jobs.enqueue("summary.generate", { sessionId: 1 });
    await jobs.runDue();
    const later = new Date(clock.now().getTime() + 60_000);
    const queued = jobs.enqueue("summary.generate", { sessionId: 1 }, later);
    const other = jobs.enqueue("summary.generate", { sessionId: 2 }, later);
    const unrelated = jobs.enqueue("help.match", { assignmentId: 1 }, later);

    jobs.discard((job) => job.kind === "summary.generate" && job.payload.sessionId === 1);

    expect(() => jobs.read(done.id)).toThrow();
    expect(() => jobs.read(queued.id)).toThrow();
    expect(jobs.read(other.id).status).toBe("queued");
    expect(jobs.read(unrelated.id).status).toBe("queued");
    expect(jobs.nextRunAt()).toEqual(later);
    clock.set(later);
    await jobs.runDue();
    expect(ran).toEqual([{ sessionId: 1 }, { sessionId: 2 }]);
  });

  it("saves progress", async () => {
    jobs.register("review.submission", async (job) => {
      jobs.progress(job, 2, 8);
      expect(jobs.read(job.id).progress).toEqual({ done: 2, total: 8 });
      jobs.complete(job, () => {});
    });
    const job = jobs.enqueue("review.submission", { runId: 1, submissionId: 1 });
    await jobs.runDue();
    expect(jobs.read(job.id).progress).toEqual({ done: 2, total: 8 });
  });

  it("marks a job done when its handler returns without calling complete", async () => {
    jobs.register("help.match", async () => {});
    const job = jobs.enqueue("help.match", { assignmentId: 1 });
    await jobs.runDue();
    expect(jobs.read(job.id).status).toBe("done");
  });

  it("fails a job whose kind has no handler", async () => {
    const job = jobs.enqueue("help.match", { assignmentId: 1 });
    await jobs.runDue();
    expect(jobs.read(job.id)).toMatchObject({ status: "failed" });
  });

  describe("after a restart", () => {
    /** Claims the job and leaves its handler hanging, as a process killed mid-job would. */
    async function interrupt(): Promise<void> {
      jobs.register("summary.generate", () => new Promise(() => {}));
      void jobs.runDue();
      await new Promise((r) => setTimeout(r, 0));
    }

    it("puts running jobs back to queued and runs them again", async () => {
      const job = jobs.enqueue("summary.generate", { sessionId: 1 });
      await interrupt();
      expect(jobs.read(job.id).status).toBe("running");

      restart();
      expect(jobs.read(job.id).status).toBe("queued");
      jobs.register("summary.generate", async (j) => writeResult(j, "done after restart"));
      await jobs.runDue();
      expect(jobs.read(job.id).status).toBe("done");
      expect(results()).toEqual(["done after restart"]);
    });

    it("writes nothing for a job interrupted before complete", async () => {
      const job = jobs.enqueue("summary.generate", { sessionId: 1 });
      jobs.register("summary.generate", async () => {
        await new Promise(() => {}); // the slow work never finishes
      });
      void jobs.runDue();
      await new Promise((r) => setTimeout(r, 0));
      restart();
      expect(results()).toEqual([]);
      expect(jobs.read(job.id).status).toBe("queued");
    });

    it("never runs a completed job again", async () => {
      let calls = 0;
      jobs.register("summary.generate", async (j) => {
        calls++;
        writeResult(j, "once");
      });
      jobs.enqueue("summary.generate", { sessionId: 1 });
      await jobs.runDue();

      restart();
      jobs.register("summary.generate", async (j) => {
        calls++;
        writeResult(j, "again");
      });
      await jobs.runDue();
      expect(calls).toBe(1);
      expect(results()).toEqual(["once"]);
    });

    it("counts attempts at claim, so a job interrupted 3 times ends failed", async () => {
      const job = jobs.enqueue("summary.generate", { sessionId: 1 });
      for (let i = 1; i <= 3; i++) {
        await interrupt();
        expect(jobs.read(job.id).attempts).toBe(i);
        restart();
      }
      expect(jobs.read(job.id)).toMatchObject({ status: "failed", attempts: 3 });
      expect(jobs.read(job.id).error).toMatch(/interrupted/i);
    });
  });

  describe("the worker timer", () => {
    it("wakes at the next run_at and runs the job", async () => {
      const ran: number[] = [];
      const timers: { at: number; fn: () => void }[] = [];
      jobs = createJobs({
        db: database.db,
        clock,
        setTimer: (fn, ms) => {
          timers.push({ at: clock.now().getTime() + ms, fn });
          return () => {};
        },
      });
      jobs.register("help.match", async (job) => {
        ran.push(job.id);
      });
      jobs.start();
      await jobs.idle();
      const job = jobs.enqueue("help.match", { assignmentId: 1 }, new Date(clock.now().getTime() + 90_000));
      const timer = timers.at(-1)!;
      expect(timer.at).toBe(clock.now().getTime() + 90_000);

      clock.advance(90_000);
      timer.fn();
      await jobs.idle();
      expect(ran).toEqual([job.id]);
      jobs.stop();
    });
  });
});
