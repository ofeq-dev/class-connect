import { execSync } from "node:child_process";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createAttendanceModule } from "./attendance";
import { systemClock } from "./clock";
import { loadConfig } from "./config";
import { createCourseModule } from "./course";
import { openDatabase } from "./db";
import { createApp } from "./http";
import { createDiskFileStore } from "./files";
import { createJobs } from "./jobs";
import { createLiveEvents } from "./live-events";
import { createOpenRouterGateway, createScriptedGateway } from "./llm";
import { createFeedbackModule } from "./feedback";
import { createHomeworkModule } from "./homework";
import { createSummariesModule } from "./summaries";

const config = loadConfig();

function commitSha(): string {
  if (config.commitSha !== "unknown") return config.commitSha;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

// Migrations run before the server listens (#19).
const database = openDatabase(config.databasePath, config.migrationsDir);
const events = createLiveEvents();
const course = createCourseModule({
  db: database.db,
  clock: systemClock,
  events,
  timeZone: config.timeZone,
});
const lecturer = course.ensureLecturer(config.lecturerName);
const attendance = createAttendanceModule({
  db: database.db,
  clock: systemClock,
  events,
  course,
  timeZone: config.timeZone,
});
const feedback = createFeedbackModule({
  db: database.db,
  clock: systemClock,
  events,
  course,
  attendance,
  timeZone: config.timeZone,
});
const jobs = createJobs({
  db: database.db,
  clock: systemClock,
  onError: (error, job) => console.error(`Job ${job.id} (${job.kind}) failed:`, error),
});
const llm =
  config.llm.adapter === "fake"
    ? createScriptedGateway({ db: database.db, clock: systemClock, delayMs: config.llm.fakeDelayMs })
    : createOpenRouterGateway({
        db: database.db,
        clock: systemClock,
        apiKey: config.llm.openRouterApiKey,
        models: config.llm.models,
      });
const files = createDiskFileStore(config.filesDir);
const summaries = createSummariesModule({ db: database.db, clock: systemClock, course, llm, jobs, files, events });
const homework = createHomeworkModule({ db: database.db, clock: systemClock, course, llm, files, events });
const sha = commitSha();

const app = createApp({
  course,
  attendance,
  feedback,
  summaries,
  homework,
  llm,
  events,
  lecturer: { id: lecturer.id, passwordHash: config.lecturerPasswordHash },
  cookieSecret: config.cookieSecret,
  sseHeartbeatMs: config.sseHeartbeatMs,
  health: () => ({ sha, migration: database.migrationVersion() }),
  clientDir: path.resolve(process.cwd(), "dist/client"),
});

// Jobs left running by the last process go back to the queue; then the worker starts (#18).
jobs.recover();
jobs.start();

// Bound to loopback only: the Cloudflare Tunnel is the only way in (ADR 0003).
serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Class Connect listening on http://127.0.0.1:${info.port}`);
});
