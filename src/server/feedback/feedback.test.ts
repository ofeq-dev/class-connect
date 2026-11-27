import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RosterEntry, Session } from "../course";
import { DomainError } from "../errors";
import type { FeedbackModule, InboxItem, ReactionGroup } from ".";
import { aClaimedStudent, aCourse, aRoster, aSession, makeTestApp, type TestApp } from "../testing";

let t: TestApp;
let courseId: number;
let session: Session;

beforeEach(() => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  session = aSession(t, courseId);
  t.fakes.events.clear();
});
afterEach(() => t.close());

const feedback = () => t.modules.feedback;
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  throw new Error("expected a refusal");
};

describe("Topics", () => {
  it("lists General and one Topic per Session before anything uses them", () => {
    const topics = feedback().listTopics(courseId);
    expect(topics.map((x) => [x.kind, x.name, x.sessionId])).toEqual([
      ["session", "Session 1", session.id],
      ["general", "General", null],
    ]);
  });
});

describe("Named Topics", () => {
  it("adds named Topics after General, renames and archives them", () => {
    const a2 = feedback().addTopic(courseId, "  Assignment 2 ");
    feedback().addTopic(courseId, "Midterm");
    expect(feedback().listTopics(courseId).map((x) => x.name)).toEqual(["Session 1", "General", "Assignment 2", "Midterm"]);

    feedback().renameTopic(courseId, a2.id, "Assignment two");
    expect(feedback().listTopics(courseId).map((x) => x.name)).toContain("Assignment two");

    feedback().archiveTopic(courseId, a2.id);
    expect(feedback().listTopics(courseId).map((x) => x.name)).not.toContain("Assignment two");
    expect(feedback().listTopics(courseId, { includeArchived: true }).find((x) => x.id === a2.id)?.archived).toBe(true);
  });

  it("refuses an empty name, and renaming or archiving General or a Session Topic", () => {
    expect(refusal(() => feedback().addTopic(courseId, "  "))).toBe("topic.name-required");
    const general = feedback().listTopics(courseId).find((x) => x.kind === "general")!;
    expect(refusal(() => feedback().renameTopic(courseId, general.id, "X"))).toBe("topic.not-named");
    expect(refusal(() => feedback().archiveTopic(courseId, general.id))).toBe("topic.not-named");
  });

  it("tells everyone in the Course when Topics change", () => {
    const a2 = feedback().addTopic(courseId, "Assignment 2");
    expect(t.fakes.events.published).toEqual([{ courseId, audience: "all", notice: { type: "topic.changed", id: a2.id } }]);
  });
});

const LOCAL = (hhmm: string) => `2026-11-30T${hhmm}:00.000+02:00`;
const topicOf = (kind: "general" | "session", sessionId?: number) =>
  feedback()
    .listTopics(courseId)
    .find((x) => x.kind === kind && (sessionId === undefined || x.sessionId === sessionId))!.id;

describe("Commenting", () => {
  it("is for claimed Students only", () => {
    aRoster(t, courseId, 1);
    const general = topicOf("general");
    expect(refusal(() => feedback().comment("no-such-device", general, { text: "Hi" }))).toBe("comment.unclaimed");
    expect(refusal(() => feedback().comment(undefined, general, { text: "Hi" }))).toBe("comment.unclaimed");
    const other = aCourse(t, "Databases").id;
    const { deviceToken } = aClaimedStudent(t, other);
    expect(refusal(() => feedback().comment(deviceToken, general, { text: "Hi" }))).toBe("comment.unclaimed");
  });

  it("refuses an empty Comment and an unknown reaction", () => {
    const { deviceToken } = aClaimedStudent(t, courseId);
    expect(refusal(() => feedback().comment(deviceToken, topicOf("general"), { text: "   " }))).toBe("comment.text-required");
    expect(refusal(() => feedback().comment(deviceToken, topicOf("general"), { reaction: "bored" }))).toBe(
      "comment.bad-reaction",
    );
  });

  it.each([
    ["09:59", "before"],
    ["10:00", "during"],
    ["11:30", "during"],
    ["11:31", "after"],
  ] as const)("on a Session Topic at %s is tagged %s the Session", (time, timing) => {
    const { deviceToken } = aClaimedStudent(t, courseId);
    t.fakes.clock.set(LOCAL(time));
    expect(feedback().comment(deviceToken, topicOf("session", session.id), { text: "Q" }).timing).toBe(timing);
  });

  it("on any other Topic carries a timestamp only", () => {
    const { deviceToken } = aClaimedStudent(t, courseId);
    const c = feedback().comment(deviceToken, topicOf("general"), { text: "Q" });
    expect(c.timing).toBeNull();
    expect(c.createdAt).toBe(t.fakes.clock.now().toISOString());
  });

  it("refuses an archived Topic", () => {
    const { deviceToken } = aClaimedStudent(t, courseId);
    const mid = feedback().addTopic(courseId, "Midterm");
    feedback().archiveTopic(courseId, mid.id);
    expect(refusal(() => feedback().comment(deviceToken, mid.id, { text: "Q" }))).toBe("comment.topic-archived");
  });

  it("stores a quick reaction with its key and label as the text", () => {
    const { deviceToken } = aClaimedStudent(t, courseId);
    const c = feedback().comment(deviceToken, topicOf("session", session.id), { reaction: "too-fast" });
    expect([c.reaction, c.text]).toEqual(["too-fast", "Too fast"]);
  });

  it("notifies the Lecturer only", () => {
    const { deviceToken } = aClaimedStudent(t, courseId);
    t.fakes.events.clear();
    const c = feedback().comment(deviceToken, topicOf("general"), { text: "Q", anonymous: true });
    expect(t.fakes.events.published).toEqual([{ courseId, audience: "lecturer", notice: { type: "comment.changed", id: c.id } }]);
  });
});

describe("Reading Comments", () => {
  let dana: { rosterEntry: RosterEntry; deviceToken: string };
  let omar: { rosterEntry: RosterEntry; deviceToken: string };
  beforeEach(() => {
    aRoster(t, courseId, 3);
    dana = aClaimedStudent(t, courseId, "1001");
    omar = aClaimedStudent(t, courseId, "1002");
  });
  const say = (who: { deviceToken: string }, topicId: number, input: { text?: string; anonymous?: boolean; reaction?: string }) =>
    feedback().comment(who.deviceToken, topicId, input);

  it("shows a named author, and never the author of an anonymous Comment", () => {
    say(dana, topicOf("general"), { text: "Named" });
    say(dana, topicOf("general"), { text: "Secret", anonymous: true });
    const list = feedback().listComments(courseId);
    expect(list.map((c) => [c.text, c.author])).toEqual([
      ["Secret", null],
      ["Named", { rosterEntryId: dana.rosterEntry.id, name: "Dana Levi" }],
    ]);
    expect(JSON.stringify(list[0])).not.toContain("Dana");
    expect(JSON.stringify(list[0])).not.toContain("rosterEntryId");
  });

  it("carries a presence note on Session Topics, anonymous ones too", () => {
    t.modules.attendance.openWindow(session.id, { ipv4: "147.235.10.20", ipv6: null });
    t.modules.attendance.checkIn(session.id, dana.rosterEntry.id, "147.235.10.21", dana.deviceToken);
    say(dana, topicOf("session", session.id), { text: "From Dana", anonymous: true });
    say(omar, topicOf("session", session.id), { text: "From Omar" });
    say(omar, topicOf("general"), { text: "General" });
    const present = Object.fromEntries(feedback().listComments(courseId).map((c) => [c.text, c.present]));
    expect(present).toEqual({ "From Dana": true, "From Omar": false, General: null });
  });

  it("filters by Topic, Student, Anonymous, status and timing", () => {
    const s = topicOf("session", session.id);
    t.fakes.clock.set(LOCAL("09:00"));
    const early = say(dana, s, { text: "early" });
    t.fakes.clock.set(LOCAL("10:30"));
    say(dana, s, { text: "during", anonymous: true });
    const g = say(omar, topicOf("general"), { text: "general" });
    feedback().setStatus(courseId, [g.id], "addressed");
    const texts = (filter: Parameters<FeedbackModule["listComments"]>[1]) =>
      feedback().listComments(courseId, filter).map((c) => c.text);

    expect(texts({ topicId: s })).toEqual(["during", "early"]);
    expect(texts({ author: dana.rosterEntry.id })).toEqual(["early"]);
    expect(texts({ author: "anonymous" })).toEqual(["during"]);
    expect(texts({ status: "addressed" })).toEqual(["general"]);
    expect(texts({ status: "new" })).toEqual(["during", "early"]);
    expect(texts({ timing: "before" })).toEqual(["early"]);
    expect(texts({ timing: "during" })).toEqual(["during"]);
    expect(texts({ topicId: s, timing: "before", author: dana.rosterEntry.id })).toEqual([early.text]);
  });

  it("lets a Student see only their own Comments, anonymous ones included", () => {
    say(dana, topicOf("general"), { text: "Mine", anonymous: true });
    say(omar, topicOf("general"), { text: "Omar's" });
    expect(feedback().mine(dana.deviceToken).map((c) => [c.text, c.anonymous, c.status])).toEqual([["Mine", true, "new"]]);
    expect(feedback().mine("unknown")).toEqual([]);
  });

  it("lets a Student delete their own Comment only while it is New", () => {
    const a = say(dana, topicOf("general"), { text: "Oops" });
    const b = say(dana, topicOf("general"), { text: "Seen" });
    expect(refusal(() => feedback().deleteComment(omar.deviceToken, a.id))).toBe("comment.not-yours");
    feedback().setStatus(courseId, [b.id], "pinned");
    expect(refusal(() => feedback().deleteComment(dana.deviceToken, b.id))).toBe("comment.not-new");
    t.fakes.events.clear();
    feedback().deleteComment(dana.deviceToken, a.id);
    expect(feedback().mine(dana.deviceToken).map((c) => c.text)).toEqual(["Seen"]);
    expect(t.fakes.events.published).toEqual([{ courseId, audience: "lecturer", notice: { type: "comment.changed", id: a.id } }]);
  });

  it("moves statuses freely, notifying the Lecturer only", () => {
    const c = say(dana, topicOf("general"), { text: "Q" });
    const status = () => feedback().listComments(courseId)[0]!.status;
    for (const next of ["addressed", "new", "ignored", "pinned", "new"] as const) {
      t.fakes.events.clear();
      feedback().setStatus(courseId, [c.id], next);
      expect(status()).toBe(next);
      expect(t.fakes.events.published).toEqual([{ courseId, audience: "lecturer", notice: { type: "comment.changed", id: c.id } }]);
    }
  });

  it("refuses a status change on another Course's Comment", () => {
    const c = say(dana, topicOf("general"), { text: "Q" });
    const other = aCourse(t, "Databases").id;
    expect(() => feedback().setStatus(other, [c.id], "addressed")).toThrow(/not found/);
  });
});

describe("The console's Comments column", () => {
  let students: { rosterEntry: RosterEntry; deviceToken: string }[];
  beforeEach(() => {
    aRoster(t, courseId, 4);
    students = ["1001", "1002", "1003", "1004"].map((id) => aClaimedStudent(t, courseId, id));
  });
  const say = (i: number, topicId: number, input: { text?: string; anonymous?: boolean; reaction?: string }) =>
    feedback().comment(students[i]!.deviceToken, topicId, input);
  const label = (item: InboxItem) => (item.kind === "comment" ? item.comment.text : `×${item.count} ${item.text}`);

  it("groups quick reactions per reaction with a count, a time range and the named authors only", () => {
    const s = topicOf("session", session.id);
    t.fakes.clock.set(LOCAL("10:19"));
    say(0, s, { reaction: "too-fast" });
    t.fakes.clock.set(LOCAL("10:20"));
    say(1, s, { reaction: "too-fast", anonymous: true });
    say(2, s, { text: "Is an alt fragment just an if/else?" });
    say(3, s, { reaction: "repeat" });
    t.fakes.clock.set(LOCAL("10:23"));
    say(2, s, { reaction: "too-fast" });

    const inbox = feedback().inbox(session.id);
    expect(inbox.open.map(label)).toEqual(["×3 Too fast", "Can you repeat that?", "Is an alt fragment just an if/else?"]);
    const group = inbox.open[0] as ReactionGroup;
    expect(group).toMatchObject({
      reaction: "too-fast",
      from: new Date(LOCAL("10:19")).toISOString(),
      to: new Date(LOCAL("10:23")).toISOString(),
      named: ["Dana Levi", "Irina Petrova"],
      anonymous: 1,
    });
    expect(JSON.stringify(group)).not.toContain("Omar");
  });

  it("applies a status to a whole group at once", () => {
    const s = topicOf("session", session.id);
    say(0, s, { reaction: "lost" });
    say(1, s, { reaction: "lost" });
    const group = feedback().inbox(session.id).open[0] as ReactionGroup;
    feedback().setStatus(courseId, group.commentIds, "pinned");
    const inbox = feedback().inbox(session.id);
    expect(inbox.pinned.map(label)).toEqual(["×2 I'm lost"]);
    expect(inbox.open).toEqual([]);
    feedback().setStatus(courseId, group.commentIds, "addressed");
    expect(feedback().inbox(session.id).dealtWith.map((c) => c.text)).toEqual(["I'm lost", "I'm lost"]);
  });

  it("puts pinned Comments on top, folds Addressed and Ignored into Dealt with", () => {
    const g = topicOf("general");
    const a = say(0, g, { text: "a" });
    say(1, g, { text: "b" });
    const c = say(2, g, { text: "c" });
    const d = say(3, g, { text: "d" });
    feedback().setStatus(courseId, [a.id], "pinned");
    feedback().setStatus(courseId, [c.id], "addressed");
    feedback().setStatus(courseId, [d.id], "ignored");
    const inbox = feedback().inbox(session.id);
    expect(inbox.pinned.map(label)).toEqual(["a"]);
    expect(inbox.open.map(label)).toEqual(["b"]);
    expect(inbox.dealtWith.map((x) => [x.text, x.status])).toEqual([
      ["d", "ignored"],
      ["c", "addressed"],
    ]);
  });

  it("keeps a Pinned Comment from an earlier Session on top of every later Session until Addressed", () => {
    const earlier = aSession(t, courseId, { date: "2026-11-23" });
    const later = aSession(t, courseId, { date: "2026-12-07" });
    const old = say(0, topicOf("session", earlier.id), { text: "Pinned last week" });
    say(1, topicOf("session", earlier.id), { text: "Left New last week" });
    feedback().setStatus(courseId, [old.id], "pinned");

    for (const s of [session, later]) expect(feedback().inbox(s.id).pinned.map(label)).toEqual(["Pinned last week"]);
    expect(feedback().inbox(session.id).open).toEqual([]);

    feedback().setStatus(courseId, [old.id], "addressed");
    expect(feedback().inbox(later.id).pinned).toEqual([]);
  });

  it("gives each Topic chip its open count", () => {
    const mid = feedback().addTopic(courseId, "Midterm");
    say(0, topicOf("session", session.id), { text: "1" });
    const p = say(1, mid.id, { text: "2" });
    const x = say(2, mid.id, { text: "3" });
    feedback().setStatus(courseId, [p.id], "pinned");
    feedback().setStatus(courseId, [x.id], "ignored");
    expect(feedback().inbox(session.id).topics.map((x) => [x.name, x.open])).toEqual([
      ["Session 1", 1],
      ["General", 0],
      ["Midterm", 1],
    ]);
  });
});
