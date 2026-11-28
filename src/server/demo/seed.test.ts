import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentHash } from "../files";
import { aCourse, anAssignmentWithCriteria, aRoster, aSession, makeTestApp, type TestApp } from "../testing";
import {
  DEMO_COURSE_NAME,
  deleteDemoCourses,
  FIXTURES_DIR,
  loadRehearsalFixtures,
  scriptRehearsalReplies,
  seedDemo,
  type SeedResult,
} from "./index";

let t: TestApp;
let seeded: SeedResult;

// The demo is on Thursday 2026-12-03, 10:00–11:30; the seed runs early that morning.
const OPTIONS = { date: "2026-12-03", start: "10:00", end: "11:30" };
const SEEDED_AT = "2026-12-03T05:00:00.000Z";

const seed = (options: Partial<typeof OPTIONS> & { replace?: boolean } = {}) =>
  seedDemo({ modules: t.modules, jobs: t.jobs, clock: t.fakes.clock, lecturerId: t.lecturer.id }, { ...OPTIONS, ...options });

beforeEach(async () => {
  t = makeTestApp();
  scriptRehearsalReplies(t.fakes.llm, await loadRehearsalFixtures());
  t.fakes.clock.set(SEEDED_AT);
  seeded = await seed();
});
afterEach(() => t.close());

describe("seed:demo on a fresh database", () => {
  it("leaves the Clock where it found it", () => {
    expect(t.fakes.clock.now().toISOString()).toBe(SEEDED_AT);
  });

  it("lists 40 unclaimed Students with demo IDs 1001–1040", () => {
    const roster = t.modules.course.listRoster(seeded.courseId);
    expect(roster).toHaveLength(40);
    expect(roster.map((e) => e.studentId).sort()).toEqual(Array.from({ length: 40 }, (_, i) => String(1001 + i)));
    expect(roster.every((e) => !e.claimed)).toBe(true);
  });

  it("makes four past weekly Sessions with attendance, and the demo Session", () => {
    const sessions = t.modules.course.listSessions(seeded.courseId);
    expect(sessions.map((s) => s.date)).toEqual(["2026-11-05", "2026-11-12", "2026-11-19", "2026-11-26", "2026-12-03"]);
    const sheet = t.modules.attendance.sheet(seeded.courseId);
    // Sessions held so far: the four past ones and today's.
    expect(sheet.sessions).toHaveLength(5);
    expect(new Set(sheet.students.flatMap((s) => s.marks))).toEqual(new Set(["present", "manual", "absent"]));
    const recorded = sessions.slice(0, 4).flatMap((s) => t.modules.attendance.checkIns(s.id).map((r) => r.state));
    // Pending check-ins never approved read as Absent once the window closed.
    expect(new Set(recorded)).toEqual(new Set(["present", "pending", "manual-present", "manual-absent"]));
  });

  it("carries a Pinned Comment from last Session onto the demo Session's view", () => {
    const inbox = t.modules.feedback.inbox(seeded.demoSessionId);
    expect(inbox.pinned).toHaveLength(1);
    expect(inbox.topics.map((x) => x.name)).toContain("Assignment 2");
  });

  it("has a past quick-reaction group and Comments in every status", () => {
    const comments = t.modules.feedback.listComments(seeded.courseId);
    expect(new Set(comments.map((c) => c.status))).toEqual(new Set(["new", "pinned", "addressed", "ignored"]));
    expect(comments.filter((c) => c.reaction === "too-fast").length).toBeGreaterThanOrEqual(3);
    expect(comments.some((c) => c.author === null) && comments.some((c) => c.author !== null)).toBe(true);
  });

  it("puts a ready draft and an incomplete draft on the demo Session, after a past closed Poll", () => {
    const polls = t.modules.feedback.sessionPolls(seeded.demoSessionId);
    const pace = polls.find((p) => p.question === "How is the pace so far?");
    expect(pace).toMatchObject({ status: "draft", complete: true });
    expect(pace?.options.map((o) => o.label)).toEqual(["Too slow", "About right", "Too fast"]);
    expect(polls.some((p) => p.status === "draft" && !p.complete)).toBe(true);
    const lastSession = t.modules.course.listSessions(seeded.courseId)[3]!;
    const past = t.modules.feedback.sessionPolls(lastSession.id).find((p) => p.status === "closed");
    expect(past?.votes).toBeGreaterThan(0);
  });

  it("publishes last Session's summary with its translations, and leaves the clip un-generated", () => {
    const lastSession = t.modules.course.listSessions(seeded.courseId)[3]!;
    const last = t.modules.summaries.forLecturer(lastSession.id);
    expect(last.state).toBe("published");
    expect(last.versions[0]!.markdown).toContain("`01:15:00` Worked example: Borrow a book");
    expect(last.translations.map((x) => [x.language, x.state])).toEqual([
      ["ar", "done"],
      ["ru", "done"],
    ]);
    const demo = t.modules.summaries.forLecturer(seeded.demoSessionId);
    expect(demo.state).toBe("ready");
    expect(demo.transcript).not.toBeNull();
  });

  it("hands in 8 Submissions to Assignment 2, due the day before, one PDF and one Late, and prints who", () => {
    const view = t.modules.homework.lecturerView(seeded.assignmentId);
    expect(view.criteria).toHaveLength(4);
    expect(view.dueAt).toBe("2026-12-02T21:59:00.000Z");
    expect(view.submissions).toHaveLength(8);
    expect(view.submissions.filter((s) => s.late)).toHaveLength(1);
    expect(view.submissions.filter((s) => s.fileName?.endsWith(".pdf"))).toHaveLength(1);
    expect(view.reviewRun).toBeNull();
    expect(seeded.submitters.map((s) => s.studentId).sort()).toEqual(
      view.submissions.map((s) => s.studentId).sort(),
    );
    expect(seeded.report).toContain(seeded.submitters[0]!.studentId);
  });

  it("flags only the near-copy pair after a review run, and its canned levels allow a Help match", async () => {
    const homework = t.modules.homework;
    homework.startReviewRun(seeded.assignmentId);
    await t.jobs.runDue();
    const view = homework.lecturerView(seeded.assignmentId);
    expect(view.submissions.every((s) => s.review.status === "drafted")).toBe(true);
    expect(view.similarPairs).toHaveLength(1);
    const pair = view.similarPairs[0]!;
    expect([pair.a.studentName, pair.b.studentName].sort()).toEqual(["Irina Petrova", "يوسف ناصر"].sort());
    const pdf = view.submissions.find((s) => s.fileName?.endsWith(".pdf"))!;
    expect(pdf.review.levels.map((l) => l.level)).toEqual(["partly", "secure", "secure", "partly"]);
    expect(view.classSummary?.commonMistakes.length).toBeGreaterThan(0);

    const byLevel = (level: string) =>
      view.submissions.filter((s) => !s.late && s.review.levels[3]!.level === level).map((s) => s.rosterEntryId);
    const criterionId = view.criteria[3]!.id;
    homework.release(seeded.assignmentId);
    homework.requestHelp(seeded.assignmentId, criterionId, byLevel("not-yet")[0]!);
    homework.offerHelp(seeded.assignmentId, criterionId, byLevel("secure")[0]!);
    homework.matchNow(seeded.assignmentId);
    await t.jobs.runDue();
    expect(homework.lecturerView(seeded.assignmentId).help.matches).toHaveLength(1);
  });
});

describe("Seeding again", () => {
  const demoCourses = () => t.modules.course.listCourses(t.lecturer.id).filter((c) => c.name.startsWith(DEMO_COURSE_NAME));
  const fixtureHash = (...parts: string[]) => contentHash(readFileSync(path.join(FIXTURES_DIR, ...parts)));

  it("is refused while a demo Course exists, unless --replace is given", async () => {
    await expect(seed()).rejects.toThrow(/--replace/);
    expect(demoCourses()).toHaveLength(1);
  });

  it("with --replace twice leaves exactly one demo Course", async () => {
    await seed({ replace: true });
    const last = await seed({ replace: true });
    expect(demoCourses().map((c) => c.id)).toEqual([last.courseId]);
  });

  it("with --replace also deletes a demo Course an earlier seed set aside", async () => {
    t.modules.course.createCourse(t.lecturer.id, `${DEMO_COURSE_NAME} (replaced 2026-11-20T08:00)`);
    const again = await seed({ replace: true });
    expect(demoCourses().map((c) => c.id)).toEqual([again.courseId]);
  });

  it("with --replace frees the rehearsal phone to claim on the new demo Course", async () => {
    t.modules.course.claim(seeded.courseId, "1001", "rehearsal-phone");
    const again = await seed({ replace: true });
    t.modules.course.claim(again.courseId, "1001", "rehearsal-phone");
    expect(t.modules.course.whoIs("rehearsal-phone")?.course.id).toBe(again.courseId);
  });

  describe("with --replace, beside a real Course", () => {
    let real: { courseId: number; sessionId: number; assignmentId: number; pdfHash: string; transcriptHash: string };
    let old: { courseId: number; sessionIds: number[]; assignmentId: number };

    beforeEach(async () => {
      const { course, attendance, feedback, summaries, homework } = t.modules;
      old = {
        courseId: seeded.courseId,
        sessionIds: course.listSessions(seeded.courseId).map((s) => s.id),
        assignmentId: seeded.assignmentId,
      };
      // Made after the first seed, so the old demo rows' ids are never handed out again.
      const courseId = aCourse(t, "Databases").id;
      const [dana] = aRoster(t, courseId, 2);
      const session = aSession(t, courseId, { date: OPTIONS.date, start: "06:00", end: "08:00" });
      attendance.openWindow(session.id, { ipv4: "198.51.100.2", ipv6: null });
      attendance.checkIn(session.id, dana!.id, "198.51.100.40", "real-phone");
      course.claim(courseId, "1001", "real-phone");
      const topic = feedback.listTopics(courseId).find((x) => x.sessionId === session.id)!;
      feedback.comment("real-phone", topic.id, { text: "Is the exam open book?" });
      const transcript = "WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nToday: normal forms.\n";
      await summaries.uploadTranscript(session.id, { text: transcript, fileName: "databases.vtt" });
      const assignmentId = anAssignmentWithCriteria(t, courseId, { dueAt: "2026-12-10T21:59:00.000Z" }).id;
      // The same PDF bytes as a demo Submission: one stored file, now used by both Courses.
      const pdf = readFileSync(path.join(FIXTURES_DIR, "submissions", "05-noa.pdf"));
      await homework.submit(assignmentId, dana!.id, { pdf: new Uint8Array(pdf), fileName: "hw.pdf" });
      real = {
        courseId,
        sessionId: session.id,
        assignmentId,
        pdfHash: contentHash(pdf),
        transcriptHash: contentHash(new TextEncoder().encode(transcript)),
      };
      await seed({ replace: true });
    });

    it("leaves the real Course and its data untouched", async () => {
      const { course, attendance, feedback, summaries, homework } = t.modules;
      expect(course.listCourses(t.lecturer.id).map((c) => c.name)).toContain("Databases");
      expect(course.listRoster(real.courseId)).toHaveLength(2);
      expect(course.whoIs("real-phone")?.course.id).toBe(real.courseId);
      expect(attendance.checkIns(real.sessionId)).toHaveLength(1);
      expect(feedback.listComments(real.courseId).map((c) => c.text)).toEqual(["Is the exam open book?"]);
      expect(summaries.forLecturer(real.sessionId).transcript).not.toBeNull();
      expect(homework.lecturerView(real.assignmentId).submissions).toHaveLength(1);
      expect(await t.fakes.files.get(real.pdfHash)).not.toBeNull();
      expect(await t.fakes.files.get(real.transcriptHash)).not.toBeNull();
    });

    it("deletes the old demo Course's attendance, Comments and Assignments", () => {
      const { attendance, feedback, homework } = t.modules;
      expect(old.sessionIds.flatMap((id) => attendance.checkIns(id))).toEqual([]);
      expect(feedback.listComments(old.courseId)).toEqual([]);
      expect(() => homework.lecturerView(old.assignmentId)).toThrow();
    });

    it("removes the old demo Course's files that nothing else uses", async () => {
      // The new demo Course uploads the same fixtures again, so delete it too to see the old ones go.
      const transcripts = [fixtureHash("transcripts", "lecture-90min.vtt"), fixtureHash("transcripts", "clip-5min.vtt")];
      for (const hash of transcripts) expect(await t.fakes.files.get(hash)).not.toBeNull();
      await deleteDemoCourses({ modules: t.modules, lecturerId: t.lecturer.id });
      for (const hash of transcripts) expect(await t.fakes.files.get(hash)).toBeNull();
      expect(demoCourses()).toEqual([]);
      // Still a real Submission's file.
      expect(await t.fakes.files.get(real.pdfHash)).not.toBeNull();
    });
  });
});
