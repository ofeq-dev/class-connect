import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RosterEntry, Session } from "../course";
import ExcelJS from "exceljs";
import { DomainError } from "../errors";
import type { AttendanceSheet, SheetMark } from ".";
import { aClaimedStudent, aCourse, aRoster, aSession, makeTestApp, type TestApp } from "../testing";

let t: TestApp;
let courseId: number;
let session: Session;
let dana: RosterEntry;
let omar: RosterEntry;
let irina: RosterEntry;

beforeEach(() => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  [dana, omar, irina] = aRoster(t, courseId, 3) as [RosterEntry, RosterEntry, RosterEntry];
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

  it("announces a midnight close that falls in a span to everyone and the projector, changing nothing", () => {
    attendance().openWindow(session.id, LECTURER);
    t.fakes.events.clear();
    attendance().announce(new Date("2026-11-30T21:00:00.000Z"), new Date("2026-11-30T21:59:59.999Z"));
    expect(t.fakes.events.published).toEqual([]);
    attendance().announce(new Date("2026-11-30T21:59:59.999Z"), new Date("2026-11-30T22:00:00.000Z"));
    expect(t.fakes.events.published.map((p) => [p.audience, p.notice])).toEqual([
      ["all", { type: "attendance.changed", id: session.id }],
      ["projector", { type: "attendance.changed", id: session.id }],
    ]);
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

  const to = (audience: string) => ({ courseId, audience, notice: { type: "attendance.changed", id: session.id } });

  it("publishes an attendance notice to the Lecturer for every Check-in, and to the Projector when the count rises", () => {
    t.fakes.events.clear();
    checkIn(dana, "147.235.10.21"); // Present: the count rises
    checkIn(omar, "2.54.1.1"); // Pending: the count doesn't
    checkIn(dana, "147.235.10.21"); // Already present
    expect(t.fakes.events.published).toEqual([to("lecturer"), to("projector"), to("lecturer"), to("lecturer")]);
  });

  it("tells the whole Course and the Projector when the window opens or closes, naming no Student", () => {
    t.fakes.events.clear();
    attendance().closeWindow(session.id);
    attendance().openWindow(session.id, LECTURER);
    expect(t.fakes.events.published).toEqual([to("all"), to("projector"), to("all"), to("projector")]);
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

describe("Network approval", () => {
  const CARRIER = "2.54.1.0/24";
  beforeEach(() => attendance().openWindow(session.id, LECTURER));

  it("turns that network's Pending check-ins Present, and leaves other networks Pending", () => {
    checkIn(dana, "2.54.1.10");
    checkIn(omar, "2.54.1.77");
    checkIn(irina, "31.154.9.9");
    attendance().approveNetwork(session.id, CARRIER);
    expect(attendance().isPresent(session.id, dana.id)).toBe(true);
    expect(attendance().isPresent(session.id, omar.id)).toBe(true);
    expect(attendance().forStudent(session.id, irina.id).status).toBe("pending");
    expect(attendance().forLecturer(session.id)).toMatchObject({ present: 2, pending: 1 });
  });

  it("makes later Check-ins from that network Present for the rest of the Session", () => {
    checkIn(dana, "2.54.1.10");
    attendance().approveNetwork(session.id, CARRIER);
    expect(checkIn(omar, "2.54.1.200")).toBe("present");
    attendance().closeWindow(session.id);
    attendance().openWindow(session.id, { ipv4: "82.80.1.1", ipv6: null });
    expect(checkIn(irina, "2.54.1.3")).toBe("present");
  });

  it("doesn't carry to the Course's next Session", () => {
    attendance().approveNetwork(session.id, CARRIER);
    const next = aSession(t, courseId, { date: "2026-12-07" });
    attendance().openWindow(next.id, LECTURER);
    expect(attendance().checkIn(next.id, dana.id, "2.54.1.10", "device-1001")).toBe("pending");
  });

  it("never happens by itself, however many Check-ins come from one network", () => {
    const many = Array.from({ length: 37 }, (_, i) => t.modules.course.addRosterEntry(courseId, String(2000 + i), `Student ${i}`));
    for (const [i, entry] of many.entries()) {
      expect(attendance().checkIn(session.id, entry.id, `2.54.1.${i + 10}`, `device-x${i}`)).toBe("pending");
    }
    expect(attendance().forLecturer(session.id)).toMatchObject({ present: 0, pending: 37 });
  });

  it("refuses once the window has closed: Pending check-ins then read as Absent", () => {
    checkIn(dana, "2.54.1.10");
    attendance().closeWindow(session.id);
    expect(refusal(() => attendance().approveNetwork(session.id, CARRIER))).toBe("check-in.closed");
    expect(attendance().isPresent(session.id, dana.id)).toBe(false);
    expect(attendance().forStudent(session.id, dana.id).status).toBe("closed");
  });

  it("tells the Lecturer, the Students and the Projector window, naming only the Session", () => {
    checkIn(dana, "2.54.1.10");
    t.fakes.events.clear();
    attendance().approveNetwork(session.id, CARRIER);
    expect(t.fakes.events.published).toEqual([
      { courseId, audience: "all", notice: { type: "attendance.changed", id: session.id } },
      { courseId, audience: "projector", notice: { type: "attendance.changed", id: session.id } },
    ]);
  });
});

describe("Manual marks", () => {
  const present = (entry: RosterEntry) => attendance().isPresent(session.id, entry.id);
  const mark = (entry: RosterEntry, value: boolean | null) => attendance().mark(session.id, entry.id, value);

  it("work before the window ever opens and after it closes", () => {
    mark(dana, true);
    expect(present(dana)).toBe(true);
    attendance().openWindow(session.id, LECTURER);
    attendance().closeWindow(session.id);
    mark(omar, true);
    expect(present(omar)).toBe(true);
    expect(attendance().forStudent(session.id, omar.id)).toMatchObject({ status: "present" });
    expect(attendance().forLecturer(session.id)).toMatchObject({ present: 2, total: 3 });
  });

  it("mark absent a Student who checked in, and the latest mark wins both ways", () => {
    attendance().openWindow(session.id, LECTURER);
    checkIn(dana, "147.235.10.21");
    mark(dana, false);
    expect(present(dana)).toBe(false);
    mark(dana, true);
    expect(present(dana)).toBe(true);
    mark(dana, false);
    expect(present(dana)).toBe(false);
  });

  it("hold a later scan once marked absent, leaving the Student Absent", () => {
    attendance().openWindow(session.id, LECTURER);
    mark(dana, false);
    expect(checkIn(dana, "147.235.10.21")).toBe("held");
    expect(present(dana)).toBe(false);
    expect(attendance().forLecturer(session.id)).toMatchObject({ present: 0, pending: 0 });
  });

  it("stand against a later scan once marked present, keeping the mark", () => {
    attendance().openWindow(session.id, LECTURER);
    mark(dana, true);
    expect(checkIn(dana, "2.54.1.1")).toBe("present");
    expect(attendance().checkIns(session.id)).toEqual([expect.objectContaining({ state: "manual-present" })]);
  });

  it("clear back to whatever the Check-in recorded, or to nothing", () => {
    attendance().openWindow(session.id, LECTURER);
    checkIn(dana, "147.235.10.21");
    checkIn(omar, "2.54.1.1");
    mark(dana, false);
    mark(omar, true);
    mark(irina, true);
    mark(dana, null);
    mark(omar, null);
    mark(irina, null);
    expect(present(dana)).toBe(true);
    expect(attendance().forStudent(session.id, omar.id).status).toBe("pending");
    expect(attendance().forStudent(session.id, irina.id).status).toBe("open");
    expect(attendance().checkIns(session.id).map((r) => r.state)).toEqual(["present", "pending"]);
  });

  it("clear back to the Check-in's own time, not the mark's", () => {
    attendance().openWindow(session.id, LECTURER);
    const checkedInAt = t.fakes.clock.now().toISOString();
    checkIn(dana, "147.235.10.21");
    t.fakes.clock.advance(20 * 60_000);
    mark(dana, false);
    t.fakes.clock.advance(5 * 60_000);
    mark(dana, null);
    const row = attendance().forLecturer(session.id).students.find((s) => s.rosterEntryId === dana.id)!;
    expect(row).toMatchObject({ status: "present", mark: null, at: checkedInAt });
  });

  it("clear to Present for a Check-in whose network was approved meanwhile", () => {
    attendance().openWindow(session.id, LECTURER);
    checkIn(omar, "2.54.1.1");
    mark(omar, false);
    attendance().approveNetwork(session.id, "2.54.1.0/24");
    expect(present(omar)).toBe(false);
    mark(omar, null);
    expect(present(omar)).toBe(true);
  });

  it("refuse a Roster entry from another Course", () => {
    const other = aRoster(t, aCourse(t, "Algorithms").id, 1)[0]!;
    expect(() => attendance().mark(session.id, other.id, true)).toThrow(/not found/i);
  });

  it("tell the Lecturer, the Students and the Projector window, naming only the Session", () => {
    mark(dana, true);
    expect(t.fakes.events.published).toEqual([
      { courseId, audience: "all", notice: { type: "attendance.changed", id: session.id } },
      { courseId, audience: "projector", notice: { type: "attendance.changed", id: session.id } },
    ]);
  });
});

describe("Held scans", () => {
  const mark = (entry: RosterEntry, value: boolean | null) => attendance().mark(session.id, entry.id, value);
  const held = () => attendance().forLecturer(session.id).held;
  const present = (entry: RosterEntry) => attendance().isPresent(session.id, entry.id);
  beforeEach(() => attendance().openWindow(session.id, LECTURER));

  it("list each Student once for the console, first scan first, and stay listed after the window closes", () => {
    mark(dana, false);
    mark(omar, false);
    t.fakes.clock.set("2026-11-30T08:18:00.000Z");
    checkIn(omar, "2.54.1.1");
    t.fakes.clock.set("2026-11-30T08:19:00.000Z");
    checkIn(dana, "147.235.10.21");
    checkIn(omar, "147.235.10.22");
    expect(held()).toEqual([
      { rosterEntryId: omar.id, name: "Omar Haddad", at: "2026-11-30T08:18:00.000Z" },
      { rosterEntryId: dana.id, name: "Dana Levi", at: "2026-11-30T08:19:00.000Z" },
    ]);
    attendance().closeWindow(session.id);
    expect(held().map((h) => h.name)).toEqual(["Omar Haddad", "Dana Levi"]);
  });

  it("log every scan's Roster entry, time, IP, block and short device ID, never the token", () => {
    mark(dana, false);
    t.fakes.clock.set("2026-11-30T08:18:00.000Z");
    checkIn(dana, "147.235.10.21", "device-1001");
    checkIn(dana, "2.54.1.1", "device-1001");
    const log = attendance().heldScans(session.id);
    expect(log).toEqual([
      { rosterEntryId: dana.id, at: "2026-11-30T08:18:00.000Z", ip: "147.235.10.21", block: "147.235.10.0/24", deviceId: "2a5a80", decision: null, decidedAt: null },
      expect.objectContaining({ ip: "2.54.1.1", block: "2.54.1.0/24", decision: null }),
    ]);
    expect(JSON.stringify(log)).not.toContain("device-100");
  });

  it("tell only the Lecturer of a scan, and not the Projector: the count doesn't change", () => {
    mark(dana, false);
    t.fakes.events.clear();
    checkIn(dana, "147.235.10.21");
    expect(t.fakes.events.published).toEqual([
      { courseId, audience: "lecturer", notice: { type: "attendance.changed", id: session.id } },
    ]);
  });

  it("are allowed: the Student is Present from their first held scan, and every scan is logged as allowed", () => {
    mark(dana, false);
    t.fakes.clock.set("2026-11-30T08:18:00.000Z");
    checkIn(dana, "2.54.1.1");
    t.fakes.clock.set("2026-11-30T08:19:00.000Z");
    checkIn(dana, "147.235.10.21");
    t.fakes.clock.set("2026-11-30T08:25:00.000Z");
    attendance().allowHeld(session.id, dana.id);
    expect(present(dana)).toBe(true);
    expect(attendance().forStudent(session.id, dana.id)).toEqual({ status: "present", at: "2026-11-30T08:18:00.000Z" });
    expect(attendance().forLecturer(session.id).students.find((s) => s.rosterEntryId === dana.id)).toMatchObject({
      status: "present",
      mark: null,
      at: "2026-11-30T08:18:00.000Z",
    });
    expect(held()).toEqual([]);
    expect(attendance().heldScans(session.id).map((h) => [h.decision, h.decidedAt])).toEqual([
      ["allowed", "2026-11-30T08:25:00.000Z"],
      ["allowed", "2026-11-30T08:25:00.000Z"],
    ]);
  });

  it("are kept absent: the ✕ stands, and the decision is logged", () => {
    mark(dana, false);
    checkIn(dana, "147.235.10.21");
    attendance().keepAbsent(session.id, dana.id);
    expect(present(dana)).toBe(false);
    expect(attendance().forLecturer(session.id).students.find((s) => s.rosterEntryId === dana.id)).toMatchObject({ mark: "absent" });
    expect(held()).toEqual([]);
    expect(attendance().heldScans(session.id)).toEqual([expect.objectContaining({ decision: "kept-absent" })]);
  });

  it("are held again on a scan after Keep absent", () => {
    mark(dana, false);
    checkIn(dana, "147.235.10.21");
    attendance().keepAbsent(session.id, dana.id);
    expect(checkIn(dana, "147.235.10.21")).toBe("held");
    expect(held().map((h) => h.name)).toEqual(["Dana Levi"]);
  });

  it("can still be allowed after the window closes, and the sheet then counts the Student Present", () => {
    mark(dana, false);
    mark(omar, false);
    checkIn(dana, "147.235.10.21");
    checkIn(omar, "147.235.10.22");
    attendance().closeWindow(session.id);
    attendance().allowHeld(session.id, dana.id);
    const { students } = attendance().sheet(courseId);
    const cell = (entry: RosterEntry) => students.find((s) => s.rosterEntryId === entry.id)!.marks[0];
    expect(cell(dana)).toBe("present");
    expect(cell(omar)).toBe("absent"); // never answered
  });

  it("refuse Allow or Keep absent with nothing held", () => {
    expect(() => attendance().allowHeld(session.id, dana.id)).toThrow(/not found/i);
    expect(() => attendance().keepAbsent(session.id, dana.id)).toThrow(/not found/i);
  });

  it("tell everyone and the Projector when allowed, and only the Lecturer when kept absent", () => {
    mark(dana, false);
    mark(omar, false);
    checkIn(dana, "147.235.10.21");
    checkIn(omar, "147.235.10.22");
    const notice = { type: "attendance.changed", id: session.id };
    t.fakes.events.clear();
    attendance().allowHeld(session.id, dana.id);
    attendance().keepAbsent(session.id, omar.id);
    expect(t.fakes.events.published).toEqual([
      { courseId, audience: "all", notice },
      { courseId, audience: "projector", notice },
      { courseId, audience: "all", notice },
    ]);
  });

  it("are settled by a later Manual mark ✓ or a cleared mark, but not by another ✕", () => {
    mark(dana, false);
    mark(omar, false);
    checkIn(dana, "147.235.10.21");
    checkIn(omar, "2.54.1.1");
    mark(dana, false);
    expect(held().map((h) => h.name)).toEqual(["Dana Levi", "Omar Haddad"]);
    mark(dana, true);
    mark(omar, null);
    expect(held()).toEqual([]);
    expect(attendance().heldScans(session.id).map((h) => h.decision)).toEqual(["replaced", "replaced"]);
    // Clearing the ✕ doesn't allow the held scan: Omar never checked in before it.
    expect(attendance().forStudent(session.id, omar.id).status).toBe("open");
  });

  it("leave the Check-in under the ✕ alone, so clearing the mark restores it", () => {
    t.fakes.clock.set("2026-11-30T09:00:00.000Z");
    checkIn(dana, "147.235.10.21");
    mark(dana, false);
    t.fakes.clock.set("2026-11-30T09:15:00.000Z");
    checkIn(dana, "2.54.1.1");
    mark(dana, null);
    expect(attendance().forStudent(session.id, dana.id)).toEqual({ status: "present", at: "2026-11-30T09:00:00.000Z" });
    expect(attendance().checkIns(session.id)).toEqual([expect.objectContaining({ ip: "147.235.10.21", block: "147.235.10.0/24" })]);
  });

  it("show the Student a held line, with the window open or closed, until the Lecturer decides", () => {
    mark(dana, false);
    t.fakes.clock.set("2026-11-30T08:18:00.000Z");
    checkIn(dana, "147.235.10.21");
    expect(attendance().forStudent(session.id, dana.id)).toEqual({ status: "held", at: "2026-11-30T08:18:00.000Z" });
    attendance().closeWindow(session.id);
    expect(attendance().forStudent(session.id, dana.id)).toEqual({ status: "held", at: "2026-11-30T08:18:00.000Z" });
    attendance().keepAbsent(session.id, dana.id);
    expect(attendance().forStudent(session.id, dana.id)).toEqual({ status: "closed", at: null });
  });

  it("don't happen after a Manual mark present, or with no mark", () => {
    mark(dana, true);
    expect(checkIn(dana, "147.235.10.21")).toBe("present");
    expect(checkIn(omar, "147.235.10.22")).toBe("present");
    expect(held()).toEqual([]);
  });
});

describe("The console's Who's here lists and network cards", () => {
  beforeEach(() => attendance().openWindow(session.id, LECTURER));

  it("puts every Roster entry in one list: waiting for approval, not here yet or present", () => {
    t.fakes.clock.set("2026-11-30T08:18:00.000Z");
    checkIn(dana, "147.235.10.21");
    checkIn(omar, "2.54.1.1");
    const { students } = attendance().forLecturer(session.id);
    expect(students).toEqual([
      { rosterEntryId: dana.id, name: "Dana Levi", studentId: "1001", status: "present", mark: null, at: "2026-11-30T08:18:00.000Z" },
      { rosterEntryId: irina.id, name: "Irina Petrova", studentId: "1003", status: "absent", mark: null, at: null },
      { rosterEntryId: omar.id, name: "Omar Haddad", studentId: "1002", status: "waiting", mark: null, at: "2026-11-30T08:18:00.000Z" },
    ]);
  });

  it("shows which way a Manual mark went, and Pending as not here once the window closes", () => {
    checkIn(omar, "2.54.1.1");
    attendance().mark(session.id, dana.id, false);
    attendance().mark(session.id, irina.id, true);
    attendance().closeWindow(session.id);
    const byName = Object.fromEntries(attendance().forLecturer(session.id).students.map((s) => [s.name, s]));
    expect(byName["Dana Levi"]).toMatchObject({ status: "absent", mark: "absent" });
    expect(byName["Irina Petrova"]).toMatchObject({ status: "present", mark: "present" });
    expect(byName["Omar Haddad"]).toMatchObject({ status: "absent", mark: null });
  });

  it("groups Pending check-ins into one card per network, in Check-in order, while the window is open", () => {
    checkIn(omar, "2.54.1.1");
    checkIn(irina, "31.154.9.9");
    checkIn(dana, "2.54.1.200");
    const { networks } = attendance().forLecturer(session.id);
    expect(networks.map((n) => n.students.map((s) => s.name))).toEqual([["Omar Haddad", "Dana Levi"], ["Irina Petrova"]]);
    expect(new Set(networks.map((n) => n.key)).size).toBe(2);
    attendance().closeWindow(session.id);
    expect(attendance().forLecturer(session.id).networks).toEqual([]);
  });

  it("names no IP address, block or device ID unless Diagnostics is on", () => {
    checkIn(dana, "147.235.10.21", "device-1001");
    checkIn(omar, "2.54.1.1");
    const calm = JSON.stringify(attendance().forLecturer(session.id));
    for (const leak of ["147.235", "2.54.1", "/24", "2a5a80", '"ip"', '"block"', '"deviceId"']) expect(calm).not.toContain(leak);
    const diag = attendance().forLecturer(session.id, { diagnostics: true });
    expect(diag.networks[0]).toMatchObject({ block: "2.54.1.0/24" });
    expect(diag.students.find((s) => s.rosterEntryId === dana.id)).toMatchObject({
      diagnostics: { ip: "147.235.10.21", block: "147.235.10.0/24", deviceId: "2a5a80" },
    });
  });
});

describe("The Attendance sheet", () => {
  // Three Sessions on three days; the fake Clock's day (Mon 2026-11-30) is the last.
  let monday: Session;
  let tuesday: Session;
  const sheet = () => attendance().sheet(courseId);

  beforeEach(() => {
    monday = aSession(t, courseId, { date: "2026-11-23" });
    tuesday = aSession(t, courseId, { date: "2026-11-24" });
  });

  it("has a row for every Roster entry by name, claimed or not, and a column per Session in date order", () => {
    aClaimedStudent(t, courseId, omar.studentId);
    const late = aSession(t, courseId, { date: "2026-11-23", start: "14:00", end: "15:30" });
    expect(sheet().students.map((s) => [s.studentId, s.name])).toEqual([
      ["1001", "Dana Levi"],
      ["1003", "Irina Petrova"],
      ["1002", "Omar Haddad"],
    ]);
    expect(sheet().sessions).toEqual([
      { id: monday.id, date: "2026-11-23", start: "10:00", end: "11:30" },
      { id: late.id, date: "2026-11-23", start: "14:00", end: "15:30" },
      { id: tuesday.id, date: "2026-11-24", start: "10:00", end: "11:30" },
      { id: session.id, date: "2026-11-30", start: "10:00", end: "11:30" },
    ]);
  });

  it("leaves out Sessions that haven't happened yet", () => {
    aSession(t, courseId, { date: "2026-12-01" });
    expect(sheet().sessions.map((s) => s.date)).toEqual(["2026-11-23", "2026-11-24", "2026-11-30"]);
  });

  it("shows Present for a Check-in, Manual for a Manual mark present, and Absent otherwise", () => {
    attendance().mark(monday.id, dana.id, true);
    attendance().mark(monday.id, omar.id, false);
    attendance().openWindow(tuesday.id, LECTURER);
    attendance().checkIn(tuesday.id, dana.id, "147.235.10.21", "device-1001");
    attendance().checkIn(tuesday.id, omar.id, "2.54.1.1", "device-1002"); // Pending, never approved
    attendance().checkIn(tuesday.id, irina.id, "147.235.10.22", "device-1003");
    attendance().mark(tuesday.id, irina.id, false);
    attendance().closeWindow(tuesday.id);
    expect(sheet().students.map((s) => s.marks)).toEqual([
      ["manual", "present", "absent"],
      ["absent", "absent", "absent"],
      ["absent", "absent", "absent"],
    ]);
  });

  it("totals each Student's attendance, counting Manual, with a percentage of the Sessions", () => {
    attendance().mark(monday.id, dana.id, true);
    attendance().openWindow(tuesday.id, LECTURER);
    attendance().checkIn(tuesday.id, dana.id, "147.235.10.21", "device-1001");
    attendance().checkIn(tuesday.id, omar.id, "147.235.10.22", "device-1002");
    expect(sheet().students.map((s) => [s.attended, s.percent])).toEqual([
      [2, 67],
      [0, 0],
      [1, 33],
    ]);
  });

  it("counts heads per Session, Manual included", () => {
    attendance().mark(monday.id, dana.id, true);
    attendance().mark(monday.id, irina.id, true);
    attendance().openWindow(session.id, LECTURER);
    checkIn(omar, "147.235.10.22");
    expect(sheet().headcount).toEqual([2, 0, 1]);
  });

  it("gives the Course desk each held Session's headcount, and none for a Session still to come", () => {
    attendance().mark(monday.id, dana.id, true);
    attendance().mark(monday.id, irina.id, true);
    const next = aSession(t, courseId, { date: "2026-12-01" });
    expect(attendance().headcounts(courseId)).toEqual({ [monday.id]: 2, [tuesday.id]: 0, [session.id]: 0 });
    expect(attendance().headcounts(courseId)).not.toHaveProperty(String(next.id));
  });

  it("reads 0% for everyone before the Course has any Sessions", () => {
    const empty = aCourse(t, "Algorithms").id;
    aRoster(t, empty, 1);
    expect(attendance().sheet(empty)).toMatchObject({
      courseName: "Algorithms",
      sessions: [],
      headcount: [],
      students: [{ marks: [], attended: 0, percent: 0 }],
    });
  });

  it("is unchanged by a Claim reset: attendance belongs to the Roster entry", () => {
    aClaimedStudent(t, courseId, dana.studentId);
    attendance().openWindow(session.id, LECTURER);
    checkIn(dana, "147.235.10.21");
    const before = sheet();
    t.modules.course.resetClaim(courseId, dana.id);
    expect(sheet()).toEqual(before);
  });

  it("exports an xlsx that reads back, with the same library, as the sheet", async () => {
    attendance().mark(monday.id, dana.id, true);
    attendance().openWindow(tuesday.id, LECTURER);
    attendance().checkIn(tuesday.id, omar.id, "147.235.10.22", "device-1002");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await attendance().exportXlsx(courseId)).buffer);
    const rows = workbook.worksheets[0]!.getSheetValues().slice(1) as unknown[][];
    expect(rows.map((r) => r.slice(1))).toEqual([
      ["Student ID", "Name", "Mon 23 Nov 2026", "Tue 24 Nov 2026", "Mon 30 Nov 2026", "Attended", "%"],
      ["1001", "Dana Levi", "Manual", "Absent", "Absent", 1, 1 / 3],
      ["1003", "Irina Petrova", "Absent", "Absent", "Absent", 0, 0],
      ["1002", "Omar Haddad", "Absent", "Present", "Absent", 1, 1 / 3],
      [undefined, "Headcount", 1, 1, 0],
    ]);
    expect(readBack(workbook)).toEqual(comparable(sheet()));
  });

  it("titles two Sessions on one day by their start times in the xlsx", async () => {
    aSession(t, courseId, { date: "2026-11-23", start: "14:00", end: "15:30" });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await attendance().exportXlsx(courseId)).buffer);
    expect((workbook.worksheets[0]!.getRow(1).values as unknown[]).slice(3, 7)).toEqual([
      "Mon 23 Nov 2026 10:00",
      "Mon 23 Nov 2026 14:00",
      "Tue 24 Nov 2026",
      "Mon 30 Nov 2026",
    ]);
  });
});

const MARK_TEXT: Record<string, SheetMark> = { Present: "present", Manual: "manual", Absent: "absent" };

/** What an exported workbook says, in the sheet's own terms (the file has no Session ids). */
function readBack(workbook: ExcelJS.Workbook) {
  const rows = workbook.worksheets[0]!.getSheetValues().slice(2) as unknown[][];
  const headcountRow = rows.pop()!;
  const n = headcountRow.length - 3;
  return {
    students: rows.map((r) => ({
      studentId: r[1],
      name: r[2],
      marks: r.slice(3, 3 + n).map((v) => MARK_TEXT[String(v)]),
      attended: r[3 + n],
      percent: Math.round(Number(r[4 + n]) * 100),
    })),
    headcount: headcountRow.slice(3),
  };
}
const comparable = (s: AttendanceSheet) => ({
  students: s.students.map(({ studentId, name, marks, attended, percent }) => ({ studentId, name, marks, attended, percent })),
  headcount: s.headcount,
});
