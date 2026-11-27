import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RosterEntry, Session } from "../course";
import { DomainError } from "../errors";
import { aCourse, aRoster, aSession, makeTestApp, type TestApp } from "../testing";

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

  it("give way to a later Check-in, which is the latest action", () => {
    attendance().openWindow(session.id, LECTURER);
    mark(dana, false);
    expect(checkIn(dana, "147.235.10.21")).toBe("present");
    expect(present(dana)).toBe(true);
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
