import { readFileSync } from "node:fs";
import path from "node:path";
import type { AttendanceModule } from "../attendance";
import { DEFAULT_TIME_ZONE, localInstant, type Clock } from "../clock";
import type { CourseModule, RosterEntry, Session } from "../course";
import type { FeedbackModule } from "../feedback";
import type { HomeworkModule } from "../homework";
import type { JobWorker } from "../jobs";
import type { SummariesModule } from "../summaries";
import { FIXTURES_DIR } from "./rehearsal";

export const DEMO_COURSE_NAME = "Software Engineering (demo)";

/** The demo Course, or one an earlier seed set aside by renaming it "… (replaced <instant>)". */
const SET_ASIDE = /^ \(replaced \d{4}-\d{2}-\d{2}T\d{2}:\d{2}\)$/;
const isDemoCourse = (name: string) =>
  name.startsWith(DEMO_COURSE_NAME) && (name === DEMO_COURSE_NAME || SET_ASIDE.test(name.slice(DEMO_COURSE_NAME.length)));

/** The seed moves the modules' Clock to each moment it re-enacts. */
export interface SettableClock extends Clock {
  set(instant: Date): void;
}

export interface SeedDeps {
  modules: {
    course: CourseModule;
    attendance: AttendanceModule;
    feedback: FeedbackModule;
    summaries: SummariesModule;
    homework: HomeworkModule;
  };
  /** The seed runs the summary and translation jobs itself, with the gateway the modules were given. */
  jobs: JobWorker;
  clock: SettableClock;
  lecturerId: number;
  timeZone?: string;
  fixturesDir?: string;
}

export interface SeedOptions {
  /** The demo Session: YYYY-MM-DD, and HH:MM wall-clock times in the app's time zone. */
  date: string;
  start: string;
  end: string;
  /** Deletes an existing demo Course, with everything it owns, instead of refusing. */
  replace?: boolean;
}

export interface SeedResult {
  courseId: number;
  demoSessionId: number;
  assignmentId: number;
  /** The seeded Students with a Submission, for a phone to claim on the day. */
  submitters: { studentId: string; name: string; pdf: boolean; late: boolean }[];
  /** What the command prints. */
  report: string;
}

/** Invented names in a mix of Hebrew, Arabic, Russian and English, so right-to-left names show. IDs 1001–1040. */
const ROSTER = [
  "Dana Levi", "עומר כהן", "Irina Petrova", "يوسف ناصر", "Noa Mizrahi", "Sam Turner", "מאיה כץ", "Layla Haddad",
  "Дмитрий Орлов", "Ethan Brooks", "נועם ברק", "ريم خوري", "Anna Sokolova", "Yael Friedman", "أحمد منصور",
  "Olivia Grant", "אורי שפירא", "Karim Saleh", "Мария Иванова", "Lucas Reed", "תמר אלון", "سلمى عودة",
  "Alexei Volkov", "Shira Peretz", "محمد عيسى", "Grace Palmer", "איתי רוזן", "Nour Darwish", "Ольга Смирнова",
  "Ben Carter", "הילה דוד", "فادي حداد", "Pavel Novikov", "Liora Ben-David", "رنا سعيد", "Chloe Evans",
  "גיל אברהם", "Tariq Aziz", "Елена Козлова", "Daniel Ward",
];

/** Which seeded Student hands in which fixture file. The canned Reviews are keyed by these texts. */
const SUBMISSIONS: { studentId: string; file: string; pdf?: true; late?: true }[] = [
  { studentId: "1001", file: "01-dana.txt" },
  { studentId: "1003", file: "02-irina.txt" },
  // A near-copy of 1003's, for similarity to flag.
  { studentId: "1004", file: "03-yusuf.txt" },
  { studentId: "1006", file: "04-sam.txt" },
  { studentId: "1005", file: "05-noa.pdf", pdf: true },
  { studentId: "1008", file: "06-layla.txt" },
  { studentId: "1009", file: "07-dmitry.txt" },
  { studentId: "1010", file: "08-ethan.txt", late: true },
];

const ASSIGNMENT = {
  title: "Assignment 2",
  instructions:
    "Write three use cases for the campus bike-share system in the brief. For each one, name the primary actor " +
    "and any supporting actors, name the use case after the primary actor's goal, write a main flow of 3–9 " +
    "numbered steps, and add the alternative flows the system must handle. Hand in text or a PDF.",
  criteria: ["Actors", "Goals", "Main flow", "Alternative flows"],
};

/** A documentation address block (TEST-NET-2) stands in for the classroom network; TEST-NET-3 for mobile data. */
const CLASSROOM = (n: number) => `198.51.100.${n}`;
const MOBILE = (n: number) => `203.0.113.${n}`;

const MIN = 60_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Deletes the Lecturer's demo Courses (by name; a real Course is never touched) and everything
 * they own: each module deletes its own data first, Course last, so an interrupted run is
 * finished by the next.
 */
export async function deleteDemoCourses(deps: { modules: SeedDeps["modules"]; lecturerId: number }): Promise<void> {
  const { course, attendance, feedback, summaries, homework } = deps.modules;
  const demos = course.listCourses(deps.lecturerId).filter((c) => isDemoCourse(c.name));
  for (const { id } of demos) {
    attendance.deleteCourseData(id);
    feedback.deleteCourseData(id);
    await summaries.deleteCourseData(id);
    await homework.deleteCourseData(id);
    course.deleteCourse(id);
  }
}

/**
 * `seed:demo`: builds the demo Course through module operations only, re-enacting its past on
 * the Clock: four weekly Sessions with attendance, Comments and a Poll, last Session's
 * published summary, and Assignment 2 with eight Submissions. Nothing moves past the Clock's
 * starting moment except the Late Submission when the due date is still ahead, and the Clock
 * is put back at the end.
 */
export async function seedDemo(deps: SeedDeps, options: SeedOptions): Promise<SeedResult> {
  const { course, attendance, feedback, summaries, homework } = deps.modules;
  const { jobs, clock, lecturerId } = deps;
  const timeZone = deps.timeZone ?? DEFAULT_TIME_ZONE;
  const fixture = (...parts: string[]) => readFileSync(path.join(deps.fixturesDir ?? FIXTURES_DIR, ...parts));

  if (!DATE.test(options.date) || !TIME.test(options.start) || !TIME.test(options.end) || options.start >= options.end) {
    throw new Error("Give --date YYYY-MM-DD, --start HH:MM and --end HH:MM, with the start before the end.");
  }
  const limit = clock.now();
  const at = (instant: Date) => clock.set(instant < limit ? instant : limit);
  const local = (date: string, time: string, plusMinutes = 0) =>
    new Date(localInstant(date, time, timeZone).getTime() + plusMinutes * MIN);

  if (!options.replace && course.listCourses(lecturerId).some((c) => c.name === DEMO_COURSE_NAME)) {
    throw new Error(`A Course named "${DEMO_COURSE_NAME}" already exists. Run again with --replace to seed a fresh one.`);
  }
  await deleteDemoCourses({ modules: deps.modules, lecturerId });

  try {
    const pastDates = [28, 21, 14, 7].map((d) => addDays(options.date, -d));
    at(local(pastDates[0]!, options.start, -7 * 24 * 60));
    const courseId = course.createCourse(lecturerId, DEMO_COURSE_NAME).id;
    course.updateCourse(courseId, { translationLanguages: ["ar", "ru"] });
    const roster = ROSTER.map((name, i) => course.addRosterEntry(courseId, String(1001 + i), name));
    const entry = (studentId: string) => roster.find((e) => e.studentId === studentId)!;
    const past = pastDates.map((date) => course.createSession(courseId, { date, start: options.start, end: options.end }));
    const demo = course.createSession(courseId, { date: options.date, start: options.start, end: options.end });
    feedback.addTopic(courseId, "Assignment 2");
    const topics = feedback.listTopics(courseId);
    const topicOf = (session: Session) => topics.find((x) => x.sessionId === session.id)!.id;
    const assignmentTopic = topics.find((x) => x.name === "Assignment 2")!.id;

    /** A Comment needs a claimed phone: claim, comment, and reset the Claim so every entry stays unclaimed. */
    const commentAs = (who: RosterEntry, topicId: number, input: { text?: string; reaction?: string; anonymous?: boolean }) => {
      const token = `seed-${who.studentId}`;
      course.claim(courseId, who.studentId, token);
      const made = feedback.comment(token, topicId, input);
      course.resetClaim(courseId, who.id);
      return made.id;
    };

    past.forEach((session, s) => {
      // Attendance: most check in on the classroom network, a few from mobile data (never approved,
      // so Absent once the window closes), some don't come; one Manual present and one Manual absent.
      at(local(session.date, session.start, -5));
      attendance.openWindow(session.id, { ipv4: CLASSROOM(2), ipv6: null });
      const absent: RosterEntry[] = [];
      roster.forEach((e, i) => {
        if ((i * 7 + s * 3) % 10 === 0) return absent.push(e);
        at(local(session.date, session.start, (i % 12) - 4));
        const mobile = (i + s) % 13 === 0;
        attendance.checkIn(session.id, e.id, mobile ? MOBILE(10 + i) : CLASSROOM(10 + i), `seed-${e.studentId}`);
      });
      at(local(session.date, session.start, 20));
      attendance.mark(session.id, absent[0]!.id, true);
      attendance.mark(session.id, roster[(s * 11 + 6) % 40]!.id, false);
      at(local(session.date, session.end));
      attendance.closeWindow(session.id);
    });

    const during = (session: Session, minutes: number) => at(local(session.date, session.start, minutes));
    const [s1, s2, s3, s4] = past as [Session, Session, Session, Session];
    during(s1, 15);
    const slides = commentAs(entry("1013"), topicOf(s1), { text: "Could you post the slides after class?" });
    const cold = commentAs(entry("1020"), topicOf(s1), { text: "It's very cold in the room today.", anonymous: true });
    feedback.setStatus(courseId, [slides], "addressed");
    feedback.setStatus(courseId, [cold], "ignored");
    during(s2, 40);
    const nfr = commentAs(entry("1002"), topicOf(s2), {
      text: "What's the difference between functional and non-functional requirements?",
    });
    feedback.setStatus(courseId, [nfr], "addressed");
    commentAs(entry("1027"), topicOf(s2), { text: "There's a lot of text on the slides.", anonymous: true });
    // A quick-reaction group: four "Too fast" in a few minutes, dealt with at once.
    const tooFast = ["1011", "1015", "1022", "1033"].map((id, i) => {
      during(s3, 30 + i);
      return commentAs(entry(id), topicOf(s3), { reaction: "too-fast", anonymous: i % 2 === 1 });
    });
    feedback.setStatus(courseId, tooFast, "addressed");
    commentAs(entry("1019"), topicOf(s3), { text: "Can we see an example of a non-functional requirement?" });
    during(s4, 25);
    const repeat = commentAs(entry("1024"), topicOf(s4), { text: "Can you repeat the part about extensions?", anonymous: true });
    feedback.setStatus(courseId, [repeat], "addressed");
    during(s4, 80);
    const pinned = commentAs(entry("1007"), topicOf(s4), {
      text: "Will Assignment 2 need alternative flows for every use case?",
    });
    feedback.setStatus(courseId, [pinned], "pinned");
    commentAs(entry("1031"), assignmentTopic, { text: "Can we hand in Assignment 2 as a PDF?" });

    // Last Session's Poll, run and closed in class.
    during(s4, 60);
    const poll = feedback.createPoll(courseId, {
      topicId: topicOf(s4),
      question: "Which part of a use case is hardest?",
      options: ["Finding the actors", "Naming the goal", "The main flow", "Alternative flows"],
      opensAt: "now",
    });
    roster.forEach((e, i) => {
      if (i % 3 === 2 || !attendance.isPresent(s4.id, e.id)) return;
      feedback.vote(poll.id, e.id, poll.options[(i * 5) % 4]!.id);
    });
    during(s4, 63);
    feedback.closePoll(courseId, poll.id);

    // Last Session's summary, generated from the 90-minute Transcript, published and translated.
    at(local(s4.date, s4.end, 120));
    await summaries.uploadTranscript(s4.id, {
      text: fixture("transcripts", "lecture-90min.vtt").toString("utf8"),
      fileName: "lecture-90min.vtt",
    });
    summaries.generate(s4.id);
    await jobs.runDue();
    const draft = summaries.forLecturer(s4.id);
    if (draft.state !== "draft") throw new Error(`Last Session's summary didn't generate: ${draft.error ?? draft.state}`);
    summaries.publish(s4.id, draft.versions[0]!.id);
    await jobs.runDue();

    // Assignment 2, set after last Session and due the evening before the demo.
    at(local(s4.date, s4.end, 10));
    const dueAt = local(addDays(options.date, -1), "23:59");
    const assignmentId = homework.setAssignment(courseId, { ...ASSIGNMENT, dueAt: dueAt.toISOString() }).id;
    for (const [i, sub] of SUBMISSIONS.entries()) {
      if (sub.late) {
        const morning = local(options.date, "08:30");
        clock.set(morning < limit ? morning : limit > dueAt ? limit : new Date(dueAt.getTime() + MIN));
      } else {
        at(local(addDays(s4.date, 1 + (i % 5)), "19:00", i * 17));
      }
      const bytes = fixture("submissions", sub.file);
      const input = sub.pdf
        ? { pdf: new Uint8Array(bytes), fileName: "assignment-2.pdf" }
        : { text: bytes.toString("utf8") };
      await homework.submit(assignmentId, entry(sub.studentId).id, input);
    }

    // The demo Session: the clip Transcript uploaded but not generated, and two draft Polls.
    clock.set(limit);
    await summaries.uploadTranscript(demo.id, {
      text: fixture("transcripts", "clip-5min.vtt").toString("utf8"),
      fileName: "clip-5min.vtt",
    });
    feedback.createPoll(courseId, {
      topicId: topicOf(demo),
      question: "How is the pace so far?",
      options: ["Too slow", "About right", "Too fast"],
    });
    feedback.createPoll(courseId, { topicId: topicOf(demo), question: "Which topic should we review next week?", options: ["Sequence diagrams"] });

    const submitters = SUBMISSIONS.map((sub) => ({
      studentId: sub.studentId,
      name: entry(sub.studentId).name,
      pdf: !!sub.pdf,
      late: !!sub.late,
    }));
    const report = [
      `Seeded "${DEMO_COURSE_NAME}" (Course ${courseId}): 40 unclaimed Students (IDs 1001–1040), 4 past Sessions,`,
      `the demo Session on ${options.date} ${options.start}–${options.end} at /s/${demo.qrCode}, and Assignment 2 due ${dueAt.toISOString()}.`,
      "Demo IDs with a Submission (claim one on a phone to show Release and Help):",
      ...submitters.map((s) => `  ${s.studentId}  ${s.name}${s.pdf ? "  (PDF)" : ""}${s.late ? "  (Late)" : ""}`),
      ...(limit < dueAt ? [`Note: Assignment 2 isn't due until ${dueAt.toISOString()}; the review run can start after that.`] : []),
    ].join("\n");
    return { courseId, demoSessionId: demo.id, assignmentId, submitters, report };
  } finally {
    clock.set(limit);
  }
}
