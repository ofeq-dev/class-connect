import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aClaimedStudent,
  aCourse,
  anAssignmentWithCriteria,
  aRoster,
  listen,
  makeTestApp,
  openSse,
  signInLecturer,
  type TestApp,
} from "../testing";

let t: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let cookie: string;
let courseId: number;

beforeEach(async () => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  aRoster(t, courseId, 2); // 1001 Dana Levi, 1002 Omar Haddad
  server = await listen(t);
  cookie = await signInLecturer(server.url);
});
afterEach(async () => {
  await server.close();
  t.close();
});

const call = (method: string, path: string, json?: unknown, as = cookie) =>
  fetch(`${server.url}/api${path}`, {
    method,
    headers: { cookie: as, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });

describe("Assignments and Submissions over HTTP", () => {
  it("sets an Assignment, drafts Criteria and lists it on the Course desk", async () => {
    t.fakes.llm.reply("draftCriteria", { criteria: ["Actors", "Goals", "Main flow"] });
    const drafted = await call("POST", `/lecturer/courses/${courseId}/assignments/draft-criteria`, {
      title: "Assignment 2",
      instructions: "Write three use cases.",
    });
    expect(await drafted.json()).toEqual({ criteria: ["Actors", "Goals", "Main flow"] });

    const refused = await call("POST", `/lecturer/courses/${courseId}/assignments`, {
      title: "Assignment 2",
      instructions: "Write three use cases.",
      dueAt: "2026-12-07T21:59:00.000Z",
      criteria: ["Actors"],
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "assignment.criteria-count" });

    const created = await call("POST", `/lecturer/courses/${courseId}/assignments`, {
      title: "Assignment 2",
      instructions: "Write three use cases.",
      dueAt: "2026-12-07T21:59:00.000Z",
      criteria: ["Actors", "Goals", "Main flow"],
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };

    const edited = await call("PUT", `/lecturer/courses/${courseId}/assignments/${id}`, {
      title: "Assignment 2",
      instructions: "Write three use cases.",
      dueAt: "2026-12-07T21:59:00.000Z",
      criteria: ["Actors", "Goals", "Main flow", "Alternatives"],
    });
    expect(await edited.json()).toMatchObject({ id, criteria: [{}, {}, {}, { label: "Alternatives" }] });
    expect(await (await call("GET", `/lecturer/courses/${courseId}/assignments`)).json()).toMatchObject([
      { id, title: "Assignment 2", state: "open", submissionCount: 0 },
    ]);
  });

  it("lets a claimed Student hand in text or a PDF and the Lecturer see it, Late after the due date", async () => {
    const assignmentId = anAssignmentWithCriteria(t, courseId).id;
    const dana = aClaimedStudent(t, courseId, "1001");
    const phone = `cc_device=${dana.deviceToken}`;
    const lecturerStream = await openSse(`${server.url}/api/lecturer/events?course=${courseId}`, cookie);

    expect(await (await call("GET", "/student/assignments", undefined, phone)).json()).toMatchObject([
      { id: assignmentId, submitted: false },
    ]);
    const text = await call("POST", `/student/assignments/${assignmentId}/submission`, { text: "Actors: a librarian." }, phone);
    expect(await text.json()).toMatchObject({ text: "Actors: a librarian.", late: false });
    expect(await lecturerStream.nextMessage()).toEqual({ type: "assignment.changed", id: assignmentId });

    const pdf = fs.readFileSync(path.resolve(__dirname, "../testing/fixtures/submission.pdf")).toString("base64");
    t.fakes.clock.set("2026-12-08T08:00:00.000Z"); // after the due date
    const replaced = await call(
      "POST",
      `/student/assignments/${assignmentId}/submission`,
      { pdfBase64: pdf, fileName: "uc.pdf" },
      phone,
    );
    expect(replaced.status).toBe(400);

    const omar = `cc_device=${aClaimedStudent(t, courseId, "1002").deviceToken}`;
    const late = await call("POST", `/student/assignments/${assignmentId}/submission`, { pdfBase64: pdf, fileName: "uc.pdf" }, omar);
    expect(await late.json()).toMatchObject({ text: "A use case names an actor and a goal.", late: true });

    expect(await (await call("GET", `/student/assignments/${assignmentId}`, undefined, phone)).json()).toMatchObject({
      canReplace: false,
      submission: { text: "Actors: a librarian." },
    });
    expect(await (await call("GET", `/lecturer/courses/${courseId}/assignments/${assignmentId}`)).json()).toMatchObject({
      state: "due",
      submissions: [
        { studentName: "Dana Levi", late: false },
        { studentName: "Omar Haddad", late: true, fileName: "uc.pdf" },
      ],
    });
    lecturerStream.close();
  });

  it("refuses an unclaimed phone and another Course's Assignment", async () => {
    const assignmentId = anAssignmentWithCriteria(t, courseId).id;
    expect((await call("GET", `/student/assignments/${assignmentId}`, undefined, "")).status).toBe(401);

    const other = aCourse(t, "Databases").id;
    aRoster(t, other, 1);
    const elsewhere = `cc_device=${aClaimedStudent(t, other, "1001", "device-elsewhere").deviceToken}`;
    expect((await call("GET", `/student/assignments/${assignmentId}`, undefined, elsewhere)).status).toBe(404);
    expect((await call("GET", `/lecturer/courses/${other}/assignments/${assignmentId}`)).status).toBe(404);
  });
});

describe("The review run over HTTP", () => {
  it("starts a run, streams progress to the Lecturer only, edits a Review and keeps similar pairs from Students", async () => {
    const assignmentId = anAssignmentWithCriteria(t, courseId).id;
    const dana = `cc_device=${aClaimedStudent(t, courseId, "1001").deviceToken}`;
    const omar = `cc_device=${aClaimedStudent(t, courseId, "1002").deviceToken}`;
    const copied = "The librarian is the main actor and her goal is to lend a book to a member with a valid card at the desk.";
    for (const phone of [dana, omar]) {
      await call("POST", `/student/assignments/${assignmentId}/submission`, { text: copied }, phone);
    }
    t.fakes.clock.set("2026-12-08T08:00:00.000Z");
    t.fakes.llm.reply("reviewSubmission", (input: { criteria: string[] }) => ({
      criteria: input.criteria.map((_, i) => ({ criterion: i + 1, level: "Partly", evidence: "", feedback: "Say more." })),
    }));
    t.fakes.llm.reply("classSummary", { commonMistakes: [] });
    const lecturerStream = await openSse(`${server.url}/api/lecturer/events?course=${courseId}`, cookie);
    const studentStream = await openSse(`${server.url}/api/student/events`, dana);

    const base = `/lecturer/courses/${courseId}/assignments/${assignmentId}`;
    const started = await call("POST", `${base}/review-run`);
    expect(await started.json()).toMatchObject({ state: "reviewing", reviewRun: { done: 0, total: 2 } });
    expect(await lecturerStream.nextMessage()).toEqual({
      type: "job.progress",
      id: assignmentId,
      progress: { done: 0, total: 2 },
    });
    expect((await call("POST", `${base}/review-run`)).status).toBe(400);

    await t.jobs.runDue();
    const v = (await (await call("GET", base)).json()) as {
      state: string;
      criteria: { id: number }[];
      submissions: { id: number }[];
      similarPairs: unknown[];
    };
    expect(v).toMatchObject({ state: "reviewed", similarPairs: [{}] });

    const levels = v.criteria.map((c) => ({ criterionId: c.id, level: "secure", evidence: "lend a book", feedback: "Good." }));
    const edited = await call("PUT", `${base}/submissions/${v.submissions[0]!.id}/review`, { levels });
    expect(await edited.json()).toMatchObject({ submissions: [{ review: { levels: [{ level: "secure" }, {}, {}, {}] } }, {}] });
    const retry = await call("POST", `${base}/submissions/${v.submissions[0]!.id}/review/retry`);
    expect(retry.status).toBe(400);
    expect((await call("POST", `${base}/review-run/retry`)).status).toBe(400);

    for (const path of [`/student/assignments/${assignmentId}`, "/student/assignments"]) {
      const body = await (await call("GET", path, undefined, dana)).text();
      expect(body).not.toMatch(/similar|passage|fingerprint|embedding|score|reviewRun/i);
    }
    // Nothing about the run reaches a Student's phone.
    await expect(studentStream.nextMessage(100)).rejects.toThrow(/timed out/);
    lecturerStream.close();
    studentStream.close();
  });
});

describe("Release and Help over HTTP", () => {
  it("Releases, takes a Help request and an offer from phones, matches now and tells each phone", async () => {
    const assignmentId = anAssignmentWithCriteria(t, courseId).id;
    const dana = `cc_device=${aClaimedStudent(t, courseId, "1001").deviceToken}`;
    const omar = `cc_device=${aClaimedStudent(t, courseId, "1002").deviceToken}`;
    await call("POST", `/student/assignments/${assignmentId}/submission`, { text: "Dana's use cases." }, dana);
    await call("POST", `/student/assignments/${assignmentId}/submission`, { text: "Omar's use cases." }, omar);
    t.fakes.clock.set("2026-12-08T08:00:00.000Z");
    const base = `/lecturer/courses/${courseId}/assignments/${assignmentId}`;

    const refused = await call("POST", `${base}/release`, {});
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "release.blocked", message: expect.stringMatching(/2 Submissions/) });

    const v = (await (await call("GET", base)).json()) as {
      criteria: { id: number }[];
      submissions: { id: number; studentName: string }[];
    };
    const byName = (n: string) => v.submissions.find((s) => s.studentName === n)!.id;
    const write = (level: string) => v.criteria.map((c) => ({ criterionId: c.id, level, evidence: "", feedback: "Ok." }));
    await call("PUT", `${base}/submissions/${byName("Dana Levi")}/review`, { levels: write("not-yet") });
    await call("PUT", `${base}/submissions/${byName("Omar Haddad")}/review`, { levels: write("secure") });

    const studentStream = await openSse(`${server.url}/api/student/events`, dana);
    const released = await call("POST", `${base}/release`, { matchDeadline: "2026-12-09T08:00:00.000Z" });
    expect(await released.json()).toMatchObject({ state: "released", matchDeadline: "2026-12-09T08:00:00.000Z" });
    expect(await studentStream.nextMessage()).toEqual({ type: "assignment.changed", id: assignmentId });

    const q1 = v.criteria[0]!.id;
    const asked = await call("POST", `/student/assignments/${assignmentId}/help/${q1}/request`, {}, dana);
    expect(await asked.json()).toMatchObject({ help: [{ criterionId: q1, state: { kind: "asked" } }, {}, {}, {}] });
    expect((await call("POST", `/student/assignments/${assignmentId}/help/${q1}/offer`, {}, dana)).status).toBe(400);
    await call("POST", `/student/assignments/${assignmentId}/help/${q1}/offer`, {}, omar);

    expect((await call("POST", `${base}/match-now`)).status).toBe(200);
    await t.jobs.runDue();
    expect(await studentStream.nextMessage()).toEqual({ type: "assignment.changed", id: assignmentId });
    const mine = (await (await call("GET", `/student/assignments/${assignmentId}`, undefined, dana)).json()) as {
      help: { state: unknown }[];
    };
    expect(mine.help[0]!.state).toEqual({ kind: "paired", with: ["Omar Haddad"] });
    const omars = await (await call("GET", `/student/assignments/${assignmentId}`, undefined, omar)).text();
    expect(omars).toContain("Dana Levi");
    expect(omars).not.toContain("not-yet");
    expect(await (await call("GET", base)).json()).toMatchObject({
      state: "matched",
      help: { matches: [{ student: { name: "Dana Levi" }, helper: { name: "Omar Haddad" } }] },
    });
    studentStream.close();
  });

  it("releases a Late Submission's Review on its own", async () => {
    const assignmentId = anAssignmentWithCriteria(t, courseId).id;
    t.fakes.clock.set("2026-12-08T08:00:00.000Z");
    const base = `/lecturer/courses/${courseId}/assignments/${assignmentId}`;
    await call("POST", `${base}/release`, {});
    const dana = `cc_device=${aClaimedStudent(t, courseId, "1001").deviceToken}`;
    await call("POST", `/student/assignments/${assignmentId}/submission`, { text: "Late work." }, dana);
    const v = (await (await call("GET", base)).json()) as { criteria: { id: number }[]; submissions: { id: number }[] };
    const levels = v.criteria.map((c) => ({ criterionId: c.id, level: "partly", evidence: "", feedback: "Ok." }));
    const sub = v.submissions[0]!.id;
    await call("PUT", `${base}/submissions/${sub}/review`, { levels });
    const out = await call("POST", `${base}/submissions/${sub}/review/release`);
    expect(await out.json()).toMatchObject({ submissions: [{ review: { releasedAt: "2026-12-08T08:00:00.000Z" } }] });
    expect(await (await call("GET", `/student/assignments/${assignmentId}`, undefined, dana)).json()).toMatchObject({
      review: { levels: [{ level: "partly" }, {}, {}, {}] },
    });
  });
});
