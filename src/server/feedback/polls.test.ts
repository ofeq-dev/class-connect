import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RosterEntry, Session } from "../course";
import { DomainError } from "../errors";
import type { LecturerPoll } from ".";
import { aCourse, aRoster, aSession, makeTestApp, type TestApp } from "../testing";

let t: TestApp;
let courseId: number;
let session: Session;
let topicId: number;
let roster: RosterEntry[];

const MIN = 60_000;

beforeEach(() => {
  t = makeTestApp(); // the fake Clock: Monday 2026-11-30, 10:00 Israel time
  courseId = aCourse(t).id;
  session = aSession(t, courseId);
  roster = aRoster(t, courseId, 3);
  topicId = t.modules.feedback.listTopics(courseId).find((x) => x.kind === "session")!.id;
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
const pace = (input: Partial<Parameters<ReturnType<typeof feedback>["createPoll"]>[1]> = {}) =>
  feedback().createPoll(courseId, {
    topicId,
    question: "How is the pace so far?",
    options: ["Too slow", "About right", "Too fast"],
    ...input,
  });
const status = (p: { id: number }) => feedback().results(courseId, p.id, "lecturer").status;
const notices = () => t.fakes.events.published.map((r) => [r.audience, r.notice.type, r.notice.id]);
const optionId = (p: LecturerPoll, label: string) => p.options.find((o) => o.label === label)!.id;

describe("Polls", () => {
  it("is created as a draft on a Topic, with its options in order", () => {
    const p = pace();
    expect(p).toMatchObject({
      topicId,
      topicName: "Session 1",
      question: "How is the pace so far?",
      status: "draft",
      complete: true,
      opensAt: null,
      closesAt: null,
      votes: 0,
    });
    expect(p.options.map((o) => o.label)).toEqual(["Too slow", "About right", "Too fast"]);
  });

  it("refuses more than six options; an incomplete draft saves but can't open or be scheduled", () => {
    expect(refusal(() => pace({ options: ["a", "b", "c", "d", "e", "f", "g"] }))).toBe("poll.too-many-options");
    const half = pace({ question: "  ", options: ["Only one", " "] });
    expect(half).toMatchObject({ question: "", complete: false, status: "draft" });
    expect(half.options.map((o) => o.label)).toEqual(["Only one"]);
    expect(refusal(() => feedback().openPoll(courseId, half.id))).toBe("poll.incomplete");
    expect(refusal(() => pace({ options: ["Only one"], opensAt: new Date("2026-11-30T08:05:00Z") }))).toBe(
      "poll.incomplete",
    );
    expect(refusal(() => pace({ options: ["Only one"], opensAt: "now" }))).toBe("poll.incomplete");
  });

  it("finishes a draft later, and refuses an edit once it has opened", () => {
    const half = pace({ question: "", options: [] });
    const done = feedback().updatePoll(courseId, half.id, { topicId, question: "Ready?", options: ["Yes", "No"] });
    expect(done).toMatchObject({ question: "Ready?", complete: true });
    feedback().openPoll(courseId, half.id);
    expect(refusal(() => feedback().updatePoll(courseId, half.id, { topicId, question: "X", options: ["a", "b"] }))).toBe(
      "poll.not-draft",
    );
  });

  it("refuses an archived Topic, or one of another Course", () => {
    const named = feedback().addTopic(courseId, "Midterm");
    feedback().archiveTopic(courseId, named.id);
    expect(refusal(() => pace({ topicId: named.id }))).toBe("poll.topic-archived");
    const other = aCourse(t, "Other");
    aSession(t, other.id);
    const theirs = feedback().listTopics(other.id)[0]!.id;
    expect(() => pace({ topicId: theirs })).toThrow(/Topic/);
  });

  it("opens and closes by hand; a closed Poll never reopens, but can be copied as a new draft", () => {
    const p = pace();
    feedback().openPoll(courseId, p.id);
    expect(status(p)).toBe("open");
    feedback().closePoll(courseId, p.id);
    expect(status(p)).toBe("closed");
    expect(refusal(() => feedback().openPoll(courseId, p.id))).toBe("poll.closed");
    const copy = feedback().copyPoll(courseId, p.id);
    expect(copy).toMatchObject({ status: "draft", question: p.question, votes: 0 });
    expect(copy.id).not.toBe(p.id);
  });

  it("refuses to close a Poll that isn't open", () => {
    expect(refusal(() => feedback().closePoll(courseId, pace().id))).toBe("poll.not-open");
  });

  it("opens and closes on schedule, read from the Clock with no write", () => {
    const p = pace({ opensAt: new Date("2026-11-30T08:05:00Z"), closeAfterMinutes: 3 });
    expect(feedback().results(courseId, p.id, "lecturer")).toMatchObject({
      status: "scheduled",
      opensAt: "2026-11-30T08:05:00.000Z",
      closesAt: "2026-11-30T08:08:00.000Z",
    });
    t.fakes.clock.advance(5 * MIN);
    expect(status(p)).toBe("open");
    t.fakes.clock.advance(3 * MIN);
    expect(status(p)).toBe("closed");
  });

  it("lets the manual action win: opening early, and closing before the scheduled close", () => {
    const p = pace({ opensAt: new Date("2026-11-30T08:30:00Z"), closeAfterMinutes: 10 });
    t.fakes.clock.advance(MIN);
    feedback().openPoll(courseId, p.id);
    // "After N min" counts from when it actually opened.
    expect(feedback().results(courseId, p.id, "lecturer")).toMatchObject({
      status: "open",
      opensAt: "2026-11-30T08:01:00.000Z",
      closesAt: "2026-11-30T08:11:00.000Z",
    });
    t.fakes.clock.advance(2 * MIN);
    feedback().closePoll(courseId, p.id);
    expect(feedback().results(courseId, p.id, "lecturer")).toMatchObject({ status: "closed", closesAt: "2026-11-30T08:03:00.000Z" });
    // The schedule no longer applies.
    t.fakes.clock.set("2026-11-30T08:30:00Z");
    expect(status(p)).toBe("closed");
  });

  it("opens now with a close after N minutes", () => {
    const p = pace({ opensAt: "now", closeAfterMinutes: 2 });
    expect(status(p)).toBe("open");
    t.fakes.clock.advance(2 * MIN);
    expect(status(p)).toBe("closed");
  });

  it("allows several Polls open at once", () => {
    const a = pace({ opensAt: "now" });
    const b = pace({ question: "Ready for the exercise?", opensAt: "now" });
    expect([status(a), status(b)]).toEqual(["open", "open"]);
  });

  it("lists this Session's Polls for the console: its own Topic, General and named Topics, not other Sessions'", () => {
    const earlier = aSession(t, courseId, { date: "2026-11-23" });
    const earlierTopic = feedback().listTopics(courseId).find((x) => x.sessionId === earlier.id)!.id;
    const general = feedback().listTopics(courseId).find((x) => x.kind === "general")!.id;
    pace({ topicId: earlierTopic, question: "Old" });
    pace({ topicId: general, question: "General one" });
    pace({ question: "Today" });
    expect(feedback().sessionPolls(session.id).map((p) => p.question)).toEqual(["General one", "Today"]);
  });

  it("gives the next scheduled open or close after a moment", () => {
    expect(feedback().nextMoment(t.fakes.clock.now())).toBeNull();
    pace({ opensAt: new Date("2026-11-30T08:05:00Z"), closeAfterMinutes: 3 });
    pace({ opensAt: "now" }); // closes by hand: no moment
    const now = t.fakes.clock.now();
    expect(feedback().nextMoment(now)?.toISOString()).toBe("2026-11-30T08:05:00.000Z");
    expect(feedback().nextMoment(new Date("2026-11-30T08:05:00Z"))?.toISOString()).toBe("2026-11-30T08:08:00.000Z");
    expect(feedback().nextMoment(new Date("2026-11-30T08:08:00Z"))).toBeNull();
  });
});

describe("Votes", () => {
  let p: LecturerPoll;
  beforeEach(() => {
    p = pace({ opensAt: "now" });
  });

  it("one Vote per Roster entry, changeable while open; the Lecturer sees live totals with no voters", () => {
    feedback().vote(p.id, roster[0]!.id, optionId(p, "Too fast"));
    feedback().vote(p.id, roster[1]!.id, optionId(p, "Too fast"));
    feedback().vote(p.id, roster[1]!.id, optionId(p, "About right"));
    const live = feedback().results(courseId, p.id, "lecturer");
    expect(live.votes).toBe(2);
    expect(live.options.map((o) => [o.label, o.votes])).toEqual([
      ["Too slow", 0],
      ["About right", 1],
      ["Too fast", 1],
    ]);
    expect(JSON.stringify(live)).not.toMatch(/Dana|Omar|rosterEntry/);
  });

  it("refuses a Vote on a closed Poll, on one not yet open, an option of another Poll, or a Student of another Course", () => {
    const later = pace();
    expect(refusal(() => feedback().vote(later.id, roster[0]!.id, later.options[0]!.id))).toBe("vote.not-open");
    expect(refusal(() => feedback().vote(p.id, roster[0]!.id, later.options[0]!.id))).toBe("vote.bad-option");
    const stranger = aRoster(t, aCourse(t, "Other").id, 1)[0]!;
    expect(() => feedback().vote(p.id, stranger.id, p.options[0]!.id)).toThrow(/Roster entry/);
    feedback().closePoll(courseId, p.id);
    expect(refusal(() => feedback().vote(p.id, roster[0]!.id, p.options[0]!.id))).toBe("vote.not-open");
  });

  it("a Student sees their own Vote but no totals until the Poll closes, then the totals", () => {
    feedback().vote(p.id, roster[0]!.id, optionId(p, "Too fast"));
    feedback().vote(p.id, roster[1]!.id, optionId(p, "About right"));
    const open = feedback().results(courseId, p.id, { rosterEntryId: roster[0]!.id });
    expect(open).toMatchObject({ status: "open", myVote: optionId(p, "Too fast"), votes: null });
    expect(open.options.every((o) => o.votes === null)).toBe(true);
    feedback().closePoll(courseId, p.id);
    const closed = feedback().results(courseId, p.id, { rosterEntryId: roster[0]!.id });
    expect(closed).toMatchObject({ status: "closed", myVote: optionId(p, "Too fast"), votes: 2 });
    expect(closed.options.map((o) => o.votes)).toEqual([0, 1, 1]);
  });

  it("the projector sees the question, options and vote count while open, the totals once closed, never voters", () => {
    feedback().vote(p.id, roster[0]!.id, optionId(p, "Too fast"));
    const open = feedback().results(courseId, p.id, "projector");
    expect(open).toEqual({
      id: p.id,
      question: "How is the pace so far?",
      status: "open",
      votes: 1,
      options: [
        { id: p.options[0]!.id, label: "Too slow", votes: null },
        { id: p.options[1]!.id, label: "About right", votes: null },
        { id: p.options[2]!.id, label: "Too fast", votes: null },
      ],
    });
    feedback().closePoll(courseId, p.id);
    expect(feedback().results(courseId, p.id, "projector").options.map((o) => o.votes)).toEqual([0, 0, 1]);
  });

  it("lists a Student's open Polls, then past results newest first; never drafts or scheduled ones", () => {
    pace({ question: "Draft" });
    pace({ question: "Later", opensAt: new Date("2026-11-30T09:00:00Z") });
    const old = pace({ question: "Old", opensAt: "now" });
    t.fakes.clock.advance(MIN);
    feedback().closePoll(courseId, old.id);
    feedback().vote(p.id, roster[0]!.id, p.options[0]!.id);
    const mine = feedback().studentPolls(courseId, roster[0]!.id);
    expect(mine.open.map((x) => [x.question, x.myVote])).toEqual([["How is the pace so far?", p.options[0]!.id]]);
    expect(mine.closed.map((x) => x.question)).toEqual(["Old"]);
  });
});

describe("Poll notices", () => {
  it("open and close reach everyone and the projector; a Vote only the Lecturer and the projector; drafts only the Lecturer", () => {
    const p = pace();
    expect(notices()).toEqual([["lecturer", "poll.changed", p.id]]);
    t.fakes.events.clear();
    feedback().openPoll(courseId, p.id);
    expect(notices()).toEqual([
      ["all", "poll.changed", p.id],
      ["projector", "poll.changed", p.id],
    ]);
    t.fakes.events.clear();
    feedback().vote(p.id, roster[0]!.id, p.options[0]!.id);
    expect(notices()).toEqual([
      ["lecturer", "poll.changed", p.id],
      ["projector", "poll.changed", p.id],
    ]);
    t.fakes.events.clear();
    feedback().closePoll(courseId, p.id);
    expect(notices()).toEqual([
      ["all", "poll.changed", p.id],
      ["projector", "poll.changed", p.id],
    ]);
  });

  it("announces scheduled opens and closes that fall in a span, changing nothing", () => {
    const p = pace({ opensAt: new Date("2026-11-30T08:05:00Z"), closeAfterMinutes: 3 });
    t.fakes.events.clear();
    feedback().announce(new Date("2026-11-30T08:00:00Z"), new Date("2026-11-30T08:04:59Z"));
    expect(notices()).toEqual([]);
    feedback().announce(new Date("2026-11-30T08:04:59Z"), new Date("2026-11-30T08:05:00Z"));
    expect(notices()).toEqual([
      ["all", "poll.changed", p.id],
      ["projector", "poll.changed", p.id],
    ]);
  });
});
