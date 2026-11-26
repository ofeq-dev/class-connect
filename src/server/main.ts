import { execSync } from "node:child_process";
import path from "node:path";
import { serve } from "@hono/node-server";
import { systemClock } from "./clock";
import { loadConfig } from "./config";
import { createCourseModule } from "./course";
import { openDatabase } from "./db";
import { createApp } from "./http";
import { createLiveEvents } from "./live-events";

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
const sha = commitSha();

const app = createApp({
  course,
  events,
  lecturer: { id: lecturer.id, passwordHash: config.lecturerPasswordHash },
  cookieSecret: config.cookieSecret,
  sseHeartbeatMs: config.sseHeartbeatMs,
  health: () => ({ sha, migration: database.migrationVersion() }),
  clientDir: path.resolve(process.cwd(), "dist/client"),
});

// Bound to loopback only: the Cloudflare Tunnel is the only way in (ADR 0003).
serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Class Connect listening on http://127.0.0.1:${info.port}`);
});
