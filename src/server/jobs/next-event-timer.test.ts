import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../course";
import { aCourse, aSession, makeTestApp, type TestApp } from "../testing";

let t: TestApp;
let courseId: number;
let session: Session;
let topicId: number;

const LECTURER = { ipv4: "147.235.10.20", ipv6: null };

beforeEach(() => {
  t = makeTestApp(); // the fake Clock: 2026-11-30 08:00Z (10:00 Israel time)
  courseId = aCourse(t).id;
  session = aSession(t, courseId);
  topicId = t.modules.feedback.listTopics(courseId)[0]!.id;
});
afterEach(() => {
  t.timer.stop();
  t.close();
});

const scheduledPoll = (opensAt: string, closeAfterMinutes?: number) =>
  t.modules.feedback.createPoll(courseId, {
    topicId,
    question: "Ready?",
    options: ["Yes", "No"],
    opensAt: new Date(opensAt),
    closeAfterMinutes,
  });
const pollNotices = () =>
  t.fakes.events.published.filter((p) => p.notice.type === "poll.changed").map((p) => [p.audience, p.notice.id]);

describe("The next-event timer", () => {
  it("wakes at the earliest of Attendance's and Feedback's next moments, computed at boot", () => {
    t.modules.attendance.openWindow(session.id, LECTURER); // closes at 22:00Z
    scheduledPoll("2026-11-30T08:05:00Z");
    t.timer.start();
    expect(t.fakes.timers.next()?.toISOString()).toBe("2026-11-30T08:05:00.000Z");
  });

  it("sends a scheduled open and close to every screen when it comes, and nothing before", () => {
    t.timer.start();
    const poll = scheduledPoll("2026-11-30T08:05:00Z", 3);
    t.fakes.events.clear();

    t.fakes.clock.set("2026-11-30T08:04:59Z");
    t.fakes.timers.fireDue();
    expect(pollNotices()).toEqual([]);

    t.fakes.clock.set("2026-11-30T08:05:00Z");
    t.fakes.timers.fireDue();
    expect(pollNotices()).toEqual([
      ["all", poll.id],
      ["projector", poll.id],
    ]);
    expect(t.modules.feedback.results(courseId, poll.id, "lecturer").status).toBe("open");

    t.fakes.events.clear();
    t.fakes.clock.set("2026-11-30T08:08:00Z");
    t.fakes.timers.fireDue();
    expect(pollNotices()).toEqual([
      ["all", poll.id],
      ["projector", poll.id],
    ]);
    expect(t.fakes.timers.next()).toBeNull();
  });

  it("recomputes when a module reports a schedule change", () => {
    t.timer.start();
    expect(t.fakes.timers.next()).toBeNull();
    t.modules.attendance.openWindow(session.id, LECTURER);
    expect(t.fakes.timers.next()?.toISOString()).toBe("2026-11-30T22:00:00.000Z");
    const poll = scheduledPoll("2026-11-30T09:00:00Z");
    expect(t.fakes.timers.next()?.toISOString()).toBe("2026-11-30T09:00:00.000Z");
    t.modules.feedback.openPoll(courseId, poll.id); // opened by hand: no scheduled open left
    expect(t.fakes.timers.next()?.toISOString()).toBe("2026-11-30T22:00:00.000Z");
  });

  it("sends the Check-in window's midnight close", () => {
    t.timer.start();
    t.modules.attendance.openWindow(session.id, LECTURER);
    t.fakes.events.clear();
    t.fakes.clock.set("2026-11-30T22:00:00Z");
    t.fakes.timers.fireDue();
    expect(t.fakes.events.published.map((p) => [p.audience, p.notice.type])).toEqual([
      ["all", "attendance.changed"],
      ["projector", "attendance.changed"],
    ]);
  });

  it("still announces a moment that passed before a late wake, even after a recompute", () => {
    t.timer.start();
    const poll = scheduledPoll("2026-11-30T08:05:00Z");
    t.fakes.clock.set("2026-11-30T08:06:00Z"); // the timer hasn't fired yet
    scheduledPoll("2026-11-30T09:00:00Z"); // a recompute before it does
    t.fakes.events.clear();
    t.fakes.timers.fireDue();
    expect(pollNotices()).toEqual([
      ["all", poll.id],
      ["projector", poll.id],
    ]);
  });
});
