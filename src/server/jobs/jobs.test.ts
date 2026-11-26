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
      ran.push((job.payload as { name: string }).name);
      running--;
      jobs.complete(job, () => {});
    });
    const now = clock.now().getTime();
    jobs.enqueue("summary.generate", { name: "second" }, new Date(now - 1000));
    jobs.enqueue("summary.generate", { name: "first" }, new Date(now - 2000));
    jobs.enqueue("summary.generate", { name: "third" });
    await jobs.runDue();
    expect(ran).toEqual(["first", "second", "third"]);
  });

  it("tells the timer when the next queued job is due", () => {
    expect(jobs.nextRunAt()).toBeNull();
    const later = new Date(clock.now().getTime() + 5 * 60_000);
    const sooner = new Date(clock.now().getTime() + 60_000);
    jobs.enqueue("help.match", {}, later);
    jobs.enqueue("help.match", {}, sooner);
    expect(jobs.nextRunAt()).toEqual(sooner);
  });

  it("retries a failing job up to 3 attempts, recording the error, then leaves it failed", async () => {
    let calls = 0;
    jobs.register("summary.generate", async () => {
      calls++;
      throw new Error(`boom ${calls}`);
    });
    const job = jobs.enqueue("summary.generate", {});

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
    const job = jobs.enqueue("summary.generate", {});
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
    const job = jobs.enqueue("summary.generate", {});
    await jobs.runDue();
    expect(calls).toBe(1);
    expect(jobs.read(job.id)).toMatchObject({ status: "failed", error: "Every model failed." });
  });

  it("retry re-queues a failed job with fresh attempts", async () => {
    let fail = true;
    jobs.register("summary.generate", async (job) => {
      if (fail) return jobs.fail(job, "nope");
      writeResult(job, "second time");
    });
    const job = jobs.enqueue("summary.generate", {});
    await jobs.runDue();
    expect(jobs.read(job.id).status).toBe("failed");

    fail = false;
    jobs.retry(job);
    expect(jobs.read(job.id)).toMatchObject({ status: "queued", attempts: 0, error: null });
    await jobs.runDue();
    expect(jobs.read(job.id).status).toBe("done");
    expect(results()).toEqual(["second time"]);
  });

  it("saves progress", async () => {
    jobs.register("review.submission", async (job) => {
      jobs.progress(job, 2, 8);
      expect(jobs.read(job.id).progress).toEqual({ done: 2, total: 8 });
      jobs.complete(job, () => {});
    });
    const job = jobs.enqueue("review.submission", {});
    await jobs.runDue();
    expect(jobs.read(job.id).progress).toEqual({ done: 2, total: 8 });
  });

  it("marks a job done when its handler returns without calling complete", async () => {
    jobs.register("help.match", async () => {});
    const job = jobs.enqueue("help.match", {});
    await jobs.runDue();
    expect(jobs.read(job.id).status).toBe("done");
  });

  it("fails a job whose kind has no handler", async () => {
    const job = jobs.enqueue("help.match", {});
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
      const job = jobs.enqueue("summary.generate", {});
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
      const job = jobs.enqueue("summary.generate", {});
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
      jobs.enqueue("summary.generate", {});
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
      const job = jobs.enqueue("summary.generate", {});
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
      const job = jobs.enqueue("help.match", {}, new Date(clock.now().getTime() + 90_000));
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
