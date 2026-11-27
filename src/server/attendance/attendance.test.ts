import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RosterEntry, Session } from "../course";
import { DomainError } from "../errors";
import { aCourse, aRoster, aSession, makeTestApp, type TestApp } from "../testing";

let t: TestApp;
let courseId: number;
let session: Session;
let dana: RosterEntry;
let omar: RosterEntry;

beforeEach(() => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  [dana, omar] = aRoster(t, courseId, 3) as [RosterEntry, RosterEntry, RosterEntry];
  session = aSession(t, courseId);
  t.fakes.events.clear();
});
afterEach(() => t.close());

const attendance = () => t.modules.attendance;
const checkIn = (entry: RosterEntry, ip: string, token = `device-${entry.studentId}`) =>
  attendance().checkIn(session.id, entry.id, ip, token);

describe("Block match (ADR 0001)", () => {
  it("gives Present for an IPv4 address in the Lecturer's /24, Pending one block away", () => {
    attendance().openWindow(session.id, { ipv4: "147.235.10.20", ipv6: null });
    expect(checkIn(dana, "147.235.10.201")).toBe("present");
    expect(checkIn(omar, "147.235.11.20")).toBe("pending");
  });

  it("gives Present for an IPv6 address in the Lecturer's /64, however it is written", () => {
    attendance().openWindow(session.id, { ipv4: null, ipv6: "2a02:6680:1100:2a::1" });
    expect(checkIn(dana, "2a02:6680:1100:002a:abcd:1234:0:9")).toBe("present");
    expect(checkIn(omar, "2a02:6680:1100:2b::1")).toBe("pending");
  });

  it("compares IPv4 only with the Lecturer's IPv4 and IPv6 only with their IPv6", () => {
    attendance().openWindow(session.id, { ipv4: "147.235.10.20", ipv6: "2a02:6680:1100:2a::1" });
    expect(checkIn(dana, "147.235.10.99")).toBe("present");
    expect(checkIn(omar, "2a02:6680:1100:2a:ffff::7")).toBe("present");
  });

  it("works with a window opened with only IPv4: every IPv6 Check-in is Pending", () => {
    attendance().openWindow(session.id, { ipv4: "147.235.10.20", ipv6: null });
    expect(checkIn(dana, "2a02:6680:1100:2a::1")).toBe("pending");
  });

  it("works with a window opened with only IPv6: every IPv4 Check-in is Pending", () => {
    attendance().openWindow(session.id, { ipv4: null, ipv6: "2a02:6680:1100:2a::1" });
    expect(checkIn(dana, "147.235.10.20")).toBe("pending");
  });

  it("counts IPv4-mapped IPv6 as IPv4, on either side", () => {
    attendance().openWindow(session.id, { ipv4: "147.235.10.20", ipv6: null });
    expect(checkIn(dana, "::ffff:147.235.10.88")).toBe("present");
    expect(checkIn(omar, "::ffff:93eb:0b01")).toBe("pending"); // 147.235.11.1
    t.modules.attendance.openWindow(session.id, { ipv4: null, ipv6: "::ffff:10.0.0.1" });
    expect(checkIn(omar, "10.0.0.200")).toBe("present");
  });

  it("gives Pending for a client IP that isn't an address", () => {
    attendance().openWindow(session.id, { ipv4: "147.235.10.20", ipv6: null });
    expect(checkIn(dana, "unknown")).toBe("pending");
  });
});

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  throw new Error("expected a refusal");
};
const LECTURER = { ipv4: "147.235.10.20", ipv6: null };
const HOUR = 60 * 60 * 1000;

describe("Check-in window", () => {
  it("refuses a Check-in before the window has ever opened", () => {
    expect(refusal(() => checkIn(dana, "147.235.10.21"))).toBe("check-in.closed");
    expect(attendance().forLecturer(session.id).window).toMatchObject({ state: "not-opened" });
  });

  it("refuses a Check-in once the Lecturer closes the window", () => {
    attendance().openWindow(session.id, LECTURER);
    expect(attendance().forLecturer(session.id).window).toMatchObject({ state: "open" });
    attendance().closeWindow(session.id);
    expect(attendance().forLecturer(session.id).window).toMatchObject({ state: "closed" });
    expect(refusal(() => checkIn(dana, "147.235.10.21"))).toBe("check-in.closed");
  });

  it("keeps earlier Check-ins when reopened, and matches against the new addresses", () => {
    attendance().openWindow(session.id, LECTURER);
    checkIn(dana, "147.235.10.21");
    attendance().closeWindow(session.id);
    attendance().openWindow(session.id, { ipv4: "82.80.1.1", ipv6: null });
    expect(attendance().isPresent(session.id, dana.id)).toBe(true);
    expect(checkIn(omar, "82.80.1.77")).toBe("present");
    expect(attendance().forLecturer(session.id)).toMatchObject({ present: 2 });
  });

  it("closes at midnight on the Clock, with no job or timer", () => {
    attendance().openWindow(session.id, LECTURER); // 10:00 Israel time, 2026-11-30
    expect(attendance().forLecturer(session.id).window).toMatchObject({
      state: "open",
      closesAt: "2026-11-30T22:00:00.000Z", // midnight in Asia/Jerusalem (UTC+2)
    });
    t.fakes.clock.set("2026-11-30T21:59:59.999Z");
    expect(checkIn(dana, "147.235.10.21")).toBe("present");
    t.fakes.clock.set("2026-11-30T22:00:00.000Z");
    expect(attendance().forLecturer(session.id).window).toMatchObject({ state: "closed" });
    expect(refusal(() => checkIn(omar, "147.235.10.22"))).toBe("check-in.closed");
  });

  it("reports the next midnight close of an open window as its next scheduled moment", () => {
    const now = t.fakes.clock.now();
    expect(attendance().nextMoment(now)).toBeNull();
    attendance().openWindow(session.id, LECTURER);
    expect(attendance().nextMoment(now)?.toISOString()).toBe("2026-11-30T22:00:00.000Z");
    attendance().closeWindow(session.id);
    expect(attendance().nextMoment(now)).toBeNull();
    attendance().openWindow(session.id, LECTURER);
    expect(attendance().nextMoment(new Date("2026-11-30T22:00:00.000Z"))).toBeNull();
  });

  it("refuses a Lecturer address of the wrong family", () => {
    expect(refusal(() => attendance().openWindow(session.id, { ipv4: "2a02::1", ipv6: null }))).toBe(
      "check-in.bad-address",
    );
    expect(refusal(() => attendance().openWindow(session.id, { ipv4: null, ipv6: "nonsense" }))).toBe(
      "check-in.bad-address",
    );
    t.fakes.clock.advance(HOUR);
    expect(attendance().forLecturer(session.id).window).toMatchObject({ state: "not-opened" });
  });
});

describe("Check-ins", () => {
  beforeEach(() => attendance().openWindow(session.id, LECTURER));

  it("logs each Check-in's Roster entry, IP, block and a short device ID, never the token", () => {
    t.fakes.clock.set("2026-11-30T08:18:00.000Z");
    checkIn(dana, "147.235.10.21", "device-1001");
    checkIn(omar, "2a02:6680:1100:2a::9", "device-1002");
    const log = attendance().checkIns(session.id);
    expect(log).toContainEqual({
      rosterEntryId: dana.id,
      state: "present",
      at: "2026-11-30T08:18:00.000Z",
      ip: "147.235.10.21",
      block: "147.235.10.0/24",
      deviceId: "2a5a80",
    });
    expect(log).toContainEqual(expect.objectContaining({ rosterEntryId: omar.id, state: "pending", block: "2a02:6680:1100:2a::/64" }));
    expect(JSON.stringify(log)).not.toContain("device-100");
  });

  it("keeps the first Check-in time when a Present Student scans again, even from another network", () => {
    t.fakes.clock.set("2026-11-30T08:18:00.000Z");
    checkIn(dana, "147.235.10.21");
    t.fakes.clock.set("2026-11-30T08:40:00.000Z");
    expect(checkIn(dana, "2.54.1.1")).toBe("present");
    expect(attendance().checkIns(session.id)).toEqual([
      expect.objectContaining({ rosterEntryId: dana.id, state: "present", at: "2026-11-30T08:18:00.000Z" }),
    ]);
  });

  it("turns a Pending check-in Present when the Student scans again from the Classroom network", () => {
    expect(checkIn(dana, "2.54.1.1")).toBe("pending");
    expect(attendance().isPresent(session.id, dana.id)).toBe(false);
    expect(checkIn(dana, "147.235.10.21")).toBe("present");
    expect(attendance().isPresent(session.id, dana.id)).toBe(true);
  });

  it("counts Present and Pending against the Roster; Pending reads as Absent once the window closes", () => {
    checkIn(dana, "147.235.10.21");
    checkIn(omar, "2.54.1.1");
    expect(attendance().forLecturer(session.id)).toMatchObject({ present: 1, pending: 1, total: 3 });
    attendance().closeWindow(session.id);
    expect(attendance().forLecturer(session.id)).toMatchObject({ present: 1, pending: 0, total: 3 });
    expect(attendance().isPresent(session.id, omar.id)).toBe(false);
  });

  it("publishes an attendance notice to the Lecturer scope only for every Check-in", () => {
    t.fakes.events.clear();
    checkIn(dana, "147.235.10.21");
    checkIn(omar, "2.54.1.1");
    checkIn(dana, "147.235.10.21");
    expect(t.fakes.events.published).toEqual(
      Array(3).fill({ courseId, audience: "lecturer", notice: { type: "attendance.changed", id: session.id } }),
    );
  });

  it("tells the whole Course when the window opens or closes, naming no Student", () => {
    t.fakes.events.clear();
    attendance().closeWindow(session.id);
    attendance().openWindow(session.id, LECTURER);
    expect(t.fakes.events.published).toEqual(
      Array(2).fill({ courseId, audience: "all", notice: { type: "attendance.changed", id: session.id } }),
    );
  });
});

describe("The Student's own Check-in line", () => {
  const line = (entry: RosterEntry) => attendance().forStudent(session.id, entry.id);

  it("waits for the window to open, then shows not checked in", () => {
    expect(line(dana)).toEqual({ status: "not-opened", at: null });
    attendance().openWindow(session.id, LECTURER);
    expect(line(dana)).toEqual({ status: "open", at: null });
  });

  it("shows Present with its time, or Pending while the window is open", () => {
    attendance().openWindow(session.id, LECTURER);
    t.fakes.clock.set("2026-11-30T08:18:00.000Z");
    checkIn(dana, "147.235.10.21");
    checkIn(omar, "2.54.1.1");
    expect(line(dana)).toEqual({ status: "present", at: "2026-11-30T08:18:00.000Z" });
    expect(line(omar)).toEqual({ status: "pending", at: "2026-11-30T08:18:00.000Z" });
  });

  it("says closed to a Student with no Check-in, or a Pending one, once the window closes", () => {
    attendance().openWindow(session.id, LECTURER);
    checkIn(omar, "2.54.1.1");
    attendance().closeWindow(session.id);
    expect(line(dana)).toEqual({ status: "closed", at: null });
    expect(line(omar)).toEqual({ status: "closed", at: null });
  });
});
