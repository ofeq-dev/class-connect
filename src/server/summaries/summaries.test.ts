import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../errors";
import { aCourse, aSession, makeTestApp, type TestApp } from "../testing";
import { NO_TIMESTAMPS_WARNING } from ".";

let t: TestApp;
let courseId: number;
let sessionId: number;

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:04.500
Dana Levi: Good morning, today is about requirements.

2
00:01:10.250 --> 00:01:15.000
Dana Levi: First, what a use case is.

3
01:02:03.000 --> 01:02:06.000
Dana Levi: Questions?
`;

const A_REPLY = {
  overview: "The Session introduced requirements and use cases.",
  outline: [
    { start: "00:00:01", topic: "Welcome and requirements" },
    { start: "00:01:10", topic: "What a use case is" },
  ],
  keyPoints: ["Requirements say what, not how.", "A use case names an actor and a goal."],
  reviewQuestions: ["What is a requirement?", "What does a use case name?", "Who is an actor?"],
};

beforeEach(() => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  sessionId = aSession(t, courseId).id;
  t.fakes.events.clear();
});
afterEach(() => t.close());

const summaries = () => t.modules.summaries;
const summaryNotices = () =>
  t.fakes.events.published.filter((p) => p.notice.type === "summary.changed");

describe("Transcripts", () => {
  it("strips VTT cue numbers and keeps the timestamps", async () => {
    const { transcript, warning } = await summaries().uploadTranscript(sessionId, { fileName: "class.vtt", text: VTT });
    expect(warning).toBeNull();
    expect(transcript.hasTimestamps).toBe(true);
    expect(transcript.text).toBe(
      [
        "[00:00:01] Dana Levi: Good morning, today is about requirements.",
        "[00:01:10] Dana Levi: First, what a use case is.",
        "[01:02:03] Dana Levi: Questions?",
      ].join("\n"),
    );
    expect(transcript.fileName).toBe("class.vtt");
  });

  it("keeps the uploaded file in the File store under its content hash", async () => {
    const { transcript } = await summaries().uploadTranscript(sessionId, { fileName: "class.vtt", text: VTT });
    const stored = await t.fakes.files.get(transcript.fileHash!);
    expect(new TextDecoder().decode(stored!)).toBe(VTT);
  });

  it("accepts a .txt file and pasted text", async () => {
    const txt = await summaries().uploadTranscript(sessionId, {
      fileName: "notes.txt",
      text: "10:02 We started with requirements.\n10:15 Then use cases.\n",
    });
    expect(txt.transcript.text).toBe("10:02 We started with requirements.\n10:15 Then use cases.");
    expect(txt.transcript.hasTimestamps).toBe(true);

    const pasted = await summaries().uploadTranscript(sessionId, { text: "  We talked about testing.  " });
    expect(pasted.transcript).toMatchObject({ text: "We talked about testing.", fileName: null, fileHash: null });
  });

  it("accepts a Transcript with no timestamps, with a warning", async () => {
    const { transcript, warning } = await summaries().uploadTranscript(sessionId, {
      text: "We talked about testing and then about deployment.",
    });
    expect(transcript.hasTimestamps).toBe(false);
    expect(warning).toBe(NO_TIMESTAMPS_WARNING);
    expect(NO_TIMESTAMPS_WARNING).toBe("No timestamps found — the outline won't have times.");
  });

  it("refuses an empty Transcript, a VTT with no captions, and other file types", async () => {
    await expect(summaries().uploadTranscript(sessionId, { text: "   " })).rejects.toThrow(DomainError);
    await expect(summaries().uploadTranscript(sessionId, { fileName: "a.vtt", text: "WEBVTT\n\n" })).rejects.toThrow(
      DomainError,
    );
    await expect(summaries().uploadTranscript(sessionId, { fileName: "a.docx", text: "hi" })).rejects.toThrow(
      DomainError,
    );
  });

  it("keeps one Transcript per Session: uploading again replaces it", async () => {
    await summaries().uploadTranscript(sessionId, { text: "first" });
    await summaries().uploadTranscript(sessionId, { text: "second" });
    expect(summaries().forLecturer(sessionId).transcript?.text).toBe("second");
  });
});

describe("Generate", () => {
  beforeEach(async () => {
    await summaries().uploadTranscript(sessionId, { fileName: "class.vtt", text: VTT });
    t.fakes.events.clear();
  });

  it("is refused before a Transcript is uploaded", () => {
    const other = aSession(t, courseId, { date: "2026-12-07" }).id;
    expect(summaries().forLecturer(other).state).toBe("no-transcript");
    expect(() => summaries().generate(other)).toThrow(DomainError);
  });

  it("queues a job and shows Summarising…", () => {
    expect(summaries().forLecturer(sessionId).state).toBe("ready");
    const view = summaries().generate(sessionId);
    expect(view.state).toBe("summarising");
    expect(t.fakes.llm.calls).toHaveLength(0);
    expect(summaryNotices()).toEqual([
      { courseId, audience: "lecturer", notice: { type: "summary.changed", id: sessionId } },
    ]);
  });

  it("makes one summarise call when the job runs, and writes version 1 by the AI with the four sections", async () => {
    t.fakes.llm.reply("summarise", A_REPLY);
    summaries().generate(sessionId);
    await t.jobs.runDue();

    expect(t.fakes.llm.calls).toEqual([
      { task: "summarise", input: expect.objectContaining({ hasTimestamps: true }) },
    ]);
    expect((t.fakes.llm.calls[0]!.input as { transcript: string }).transcript).toContain("[00:01:10]");

    const view = summaries().forLecturer(sessionId);
    expect(view.state).toBe("draft");
    expect(view.versions).toHaveLength(1);
    const v1 = view.versions[0]!;
    expect(v1).toMatchObject({ number: 1, author: "ai" });
    expect(v1.markdown).toContain("## Overview\n\nThe Session introduced requirements and use cases.");
    expect(v1.markdown).toContain("## Outline\n\n- `00:00:01` Welcome and requirements\n- `00:01:10` What a use case is");
    expect(v1.markdown).toContain("## Key points\n\n- Requirements say what, not how.");
    expect(v1.markdown).toContain(
      "## Review questions\n\n1. What is a requirement?\n2. What does a use case name?\n3. Who is an actor?",
    );
  });

  it("writes an outline without times for a Transcript with no timestamps", async () => {
    await summaries().uploadTranscript(sessionId, { text: "We covered requirements, then use cases." });
    t.fakes.llm.reply("summarise", {
      ...A_REPLY,
      outline: [
        { start: null, topic: "Requirements" },
        { start: "00:10", topic: "Use cases" },
      ],
    });
    summaries().generate(sessionId);
    await t.jobs.runDue();

    expect(t.fakes.llm.calls[0]!.input).toMatchObject({ hasTimestamps: false });
    const markdown = summaries().forLecturer(sessionId).versions[0]!.markdown;
    expect(markdown).toContain("## Outline\n\n- Requirements\n- Use cases\n");
    expect(markdown).not.toContain("`");
  });

  it("leaves the summary failed with the error on an LlmError, and Retry queues the job again", async () => {
    t.fakes.llm.fail("summarise", "all-models-failed", "Every model failed.");
    summaries().generate(sessionId);
    await t.jobs.runDue();

    expect(t.fakes.llm.calls).toHaveLength(1); // no automatic retry: the gateway already tried every model
    let view = summaries().forLecturer(sessionId);
    expect(view).toMatchObject({ state: "failed", error: "Every model failed.", versions: [] });

    t.fakes.llm.reply("summarise", A_REPLY);
    view = summaries().retry(sessionId);
    expect(view.state).toBe("summarising");
    await t.jobs.runDue();
    view = summaries().forLecturer(sessionId);
    expect(view.state).toBe("draft");
    expect(view.versions).toHaveLength(1);
  });

  it("shows the daily-limit error the same way", async () => {
    t.fakes.llm.fail("summarise", "daily-limit", "Today's 1000 LLM requests are used up.");
    summaries().generate(sessionId);
    await t.jobs.runDue();
    expect(summaries().forLecturer(sessionId)).toMatchObject({
      state: "failed",
      error: "Today's 1000 LLM requests are used up.",
    });
  });

  it("refuses Retry when nothing failed, and Generate while already summarising", async () => {
    expect(() => summaries().retry(sessionId)).toThrow(DomainError);
    summaries().generate(sessionId);
    expect(() => summaries().generate(sessionId)).toThrow(DomainError);
  });

  it("adds a version when regenerating, never overwriting one", async () => {
    t.fakes.llm.reply("summarise", A_REPLY);
    summaries().generate(sessionId);
    await t.jobs.runDue();
    t.fakes.llm.reply("summarise", { ...A_REPLY, overview: "A second take." });
    summaries().generate(sessionId);
    await t.jobs.runDue();

    const versions = summaries().forLecturer(sessionId).versions;
    expect(versions.map((v) => [v.number, v.author])).toEqual([
      [2, "ai"],
      [1, "ai"],
    ]);
    expect(versions[0]!.markdown).toContain("A second take.");
    expect(versions[1]!.markdown).toContain("introduced requirements");
  });

  it("publishes a notice for Summarising…, done and failed", async () => {
    t.fakes.llm.reply("summarise", A_REPLY);
    summaries().generate(sessionId);
    expect(summaryNotices()).toHaveLength(1);
    await t.jobs.runDue();
    expect(summaryNotices()).toHaveLength(2);

    t.fakes.llm.fail("summarise", "timeout");
    summaries().generate(sessionId);
    await t.jobs.runDue();
    expect(summaryNotices()).toHaveLength(4);
    expect(summaryNotices().every((n) => n.courseId === courseId && n.audience === "lecturer")).toBe(true);
    expect(summaryNotices().every((n) => n.notice.id === sessionId)).toBe(true);
  });
});

describe("The Course desk section", () => {
  it("lists each Session with its summary state", async () => {
    const later = aSession(t, courseId, { date: "2026-12-07" }).id;
    await summaries().uploadTranscript(sessionId, { text: "Some words." });
    t.fakes.llm.reply("summarise", A_REPLY);
    summaries().generate(sessionId);
    await t.jobs.runDue();

    expect(summaries().forCourse(courseId)).toEqual([
      { sessionId, state: "draft", error: null },
      { sessionId: later, state: "no-transcript", error: null },
    ]);
  });
});

describe("The scripted adapter's contract", () => {
  it("holds scripted replies to the summarise schema, as the real gateway would", async () => {
    await summaries().uploadTranscript(sessionId, { text: "Some words." });
    t.fakes.llm.reply("summarise", { ...A_REPLY, reviewQuestions: ["Only one?"] });
    summaries().generate(sessionId);
    await t.jobs.runDue();
    expect(summaries().forLecturer(sessionId)).toMatchObject({ state: "failed" });
    expect(summaries().forLecturer(sessionId).error).toMatch(/3.5 review questions/);
  });
});
