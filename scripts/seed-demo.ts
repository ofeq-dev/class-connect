/**
 * npm run seed:demo -- --date <YYYY-MM-DD> --start <HH:MM> --end <HH:MM> [--replace]
 *
 * Builds the demo Course in the configured database (DATABASE_PATH, FILES_DIR) through module
 * operations only, with the canned fake LLM, so it spends no LLM requests. Safe on production
 * while the app runs; open the console again afterwards to see it.
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { createAttendanceModule } from "../src/server/attendance";
import { DEFAULT_TIME_ZONE } from "../src/server/clock";
import { createCourseModule } from "../src/server/course";
import { openDatabase } from "../src/server/db";
import { createRehearsalGateway, loadRehearsalFixtures, seedDemo } from "../src/server/demo";
import { createFeedbackModule } from "../src/server/feedback";
import { createDiskFileStore } from "../src/server/files";
import { createHomeworkModule } from "../src/server/homework";
import { createJobs } from "../src/server/jobs";
import { createLiveEvents } from "../src/server/live-events";
import { createSummariesModule } from "../src/server/summaries";

const USAGE = "Usage: npm run seed:demo -- --date YYYY-MM-DD --start HH:MM --end HH:MM [--replace]";

const { values } = parseArgs({
  options: {
    date: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    replace: { type: "boolean", default: false },
  },
});
if (!values.date || !values.start || !values.end) {
  console.error(USAGE);
  process.exit(1);
}

const env = process.env;
const timeZone = env.APP_TIME_ZONE ?? DEFAULT_TIME_ZONE;
const database = openDatabase(
  env.DATABASE_PATH ?? "./class-connect.db",
  env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "drizzle"),
);
// The running app may be writing too; wait for its lock rather than fail.
database.sqlite.pragma("busy_timeout = 5000");

// The seed re-enacts the Course's past by moving this Clock; it starts, and ends, at now.
let current = new Date();
const clock = { now: () => new Date(current), set: (instant: Date) => (current = new Date(instant)) };
const db = database.db;
const events = createLiveEvents();
const scheduleChanged = () => {};
const course = createCourseModule({ db, clock, events, timeZone });
const lecturer = course.ensureLecturer(env.LECTURER_NAME ?? "Lecturer");
const attendance = createAttendanceModule({ db, clock, events, course, timeZone, scheduleChanged });
const feedback = createFeedbackModule({ db, clock, events, course, attendance, timeZone, scheduleChanged });
const jobs = createJobs({ db, clock });
const llm = createRehearsalGateway({ db, clock, fixtures: await loadRehearsalFixtures() });
const files = createDiskFileStore(env.FILES_DIR ?? "./files");
const summaries = createSummariesModule({ db, clock, course, llm, jobs, files, events });
const homework = createHomeworkModule({ db, clock, course, llm, files, events, jobs });

try {
  const result = await seedDemo(
    { modules: { course, attendance, feedback, summaries, homework }, jobs, clock, lecturerId: lecturer.id, timeZone },
    { date: values.date, start: values.start, end: values.end, replace: values.replace },
  );
  console.log(result.report);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  database.close();
}
