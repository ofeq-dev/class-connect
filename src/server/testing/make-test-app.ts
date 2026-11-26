import path from "node:path";
import { DEFAULT_TIME_ZONE } from "../clock";
import { createCourseModule } from "../course";
import { openDatabase } from "../db";
import { createApp } from "../http";
import { createJobs } from "../jobs";
import { createScriptedGateway } from "../llm";
import { createSummariesModule } from "../summaries";
import { hashPassword } from "../lecturer-auth";
import { FakeClock } from "./fake-clock";
import { MemoryFileStore } from "./memory-file-store";
import { RecordingEvents } from "./recording-events";

export const TEST_PASSWORD = "correct horse battery staple";
export const TEST_COOKIE_SECRET = "test-cookie-secret-test-cookie-secret";
const passwordHash = hashPassword(TEST_PASSWORD);

export interface TestAppOptions {
  sseHeartbeatMs?: number;
}

/**
 * The whole module graph over a fresh in-memory database with the real migrations and the
 * fakes for the injected seams. One helper for module tests and end-to-end tests.
 */
export function makeTestApp(options: TestAppOptions = {}) {
  const database = openDatabase(":memory:", path.resolve(process.cwd(), "drizzle"));
  const clock = new FakeClock();
  const events = new RecordingEvents();
  const course = createCourseModule({ db: database.db, clock, events, timeZone: DEFAULT_TIME_ZONE });
  const lecturer = course.ensureLecturer("Test Lecturer");
  // The real SQLite-backed worker, with no timer: tests call runDue() after moving the Clock.
  const jobs = createJobs({ db: database.db, clock });
  const llm = createScriptedGateway({ db: database.db, clock });
  const files = new MemoryFileStore();
  const summaries = createSummariesModule({ db: database.db, clock, course, llm, jobs, files, events });

  const app = createApp({
    course,
    summaries,
    llm,
    events,
    lecturer: { id: lecturer.id, passwordHash },
    cookieSecret: TEST_COOKIE_SECRET,
    sseHeartbeatMs: options.sseHeartbeatMs ?? 25_000,
    health: () => ({ sha: "test-sha", migration: database.migrationVersion() }),
  });

  return {
    app,
    modules: { course, summaries },
    fakes: { clock, events, llm, files },
    jobs,
    lecturer,
    database,
    close: () => database.close(),
  };
}

export type TestApp = ReturnType<typeof makeTestApp>;
