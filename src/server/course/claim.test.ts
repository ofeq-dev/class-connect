import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError } from "../errors";
import { aCourse, aRoster, makeTestApp, type TestApp } from "../testing";

let t: TestApp;
let courseId: number;
beforeEach(() => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  aRoster(t, courseId, 3); // 1001 Dana Levi, 1002 Omar Haddad, 1003 Irina Petrova
  t.fakes.events.clear();
});
afterEach(() => t.close());

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  throw new Error("expected a refusal");
};

describe("Claim (ADR 0002)", () => {
  it("refuses an unknown student ID", () => {
    expect(refusal(() => t.modules.course.claim(courseId, "9999", "token-a"))).toBe("claim.unknown-student");
  });

  it("binds the entry and resolves the raw token to that Student and Course", () => {
    const entry = t.modules.course.claim(courseId, " 1001 ", "token-a");
    expect(entry).toMatchObject({ studentId: "1001", name: "Dana Levi", claimed: true, claimedAt: "2026-11-30T08:00:00.000Z" });
    expect(t.modules.course.whoIs("token-a")).toEqual({
      course: t.modules.course.readCourse(t.lecturer.id, courseId),
      rosterEntry: entry,
    });
  });

  it("resolves nothing for no token or an unknown one", () => {
    t.modules.course.claim(courseId, "1001", "token-a");
    expect(t.modules.course.whoIs("token-b")).toBeNull();
    expect(t.modules.course.whoIs("")).toBeNull();
    expect(t.modules.course.whoIs(undefined)).toBeNull();
  });

  it("returns the Roster name for the confirm step before anything is bound", () => {
    expect(t.modules.course.findRosterEntry(courseId, "1002")).toMatchObject({ name: "Omar Haddad", claimed: false });
    expect(t.modules.course.listRoster(courseId).every((e) => !e.claimed)).toBe(true);
  });

  it("lets the first claim win and refuses the same entry from another device", () => {
    t.modules.course.claim(courseId, "1001", "token-a");
    expect(refusal(() => t.modules.course.claim(courseId, "1001", "token-b"))).toBe("claim.already-claimed");
    expect(t.modules.course.whoIs("token-a")?.rosterEntry.studentId).toBe("1001");
    expect(t.modules.course.whoIs("token-b")).toBeNull();
  });

  it("refuses a second entry for a device that already claimed one on the Course", () => {
    t.modules.course.claim(courseId, "1001", "token-a");
    expect(refusal(() => t.modules.course.claim(courseId, "1002", "token-a"))).toBe("claim.device-already-bound");
    expect(t.modules.course.findRosterEntry(courseId, "1002")?.claimed).toBe(false);
  });

  it("treats claiming one's own entry again from the same device as done", () => {
    const first = t.modules.course.claim(courseId, "1001", "token-a");
    t.fakes.clock.advance(60_000);
    expect(t.modules.course.claim(courseId, "1001", "token-a")).toEqual(first);
  });

  // Reads the whole database file, not a table: the raw token must appear nowhere in it.
  it("stores only the token's hash, never the raw token", () => {
    t.modules.course.claim(courseId, "1001", "raw-device-token-abc");
    const dump = t.database.sqlite.serialize().toString("latin1");
    expect(dump).not.toContain("raw-device-token-abc");
  });

  it("notifies the Lecturer that the Roster changed", () => {
    t.modules.course.claim(courseId, "1001", "token-a");
    expect(t.fakes.events.published).toEqual([
      { courseId, audience: "lecturer", notice: { type: "roster.changed", id: courseId } },
    ]);
  });
});

describe("Claim reset", () => {
  it("releases the binding at once: the old token stops resolving and a new claim succeeds", () => {
    const entry = t.modules.course.claim(courseId, "1001", "old-phone");
    t.modules.course.resetClaim(courseId, entry.id);
    expect(t.modules.course.whoIs("old-phone")).toBeNull();
    expect(t.modules.course.claim(courseId, "1001", "new-phone").claimed).toBe(true);
    expect(t.modules.course.whoIs("new-phone")?.rosterEntry.id).toBe(entry.id);
  });
});

describe("A device across Courses", () => {
  it("can claim one entry per Course, and resolves to the most recently claimed Course by default", () => {
    const other = aCourse(t, "Algorithms").id;
    t.modules.course.addRosterEntry(other, "1001", "Dana Levi");
    t.modules.course.claim(courseId, "1001", "token-a");
    t.fakes.clock.advance(60_000);
    t.modules.course.claim(other, "1001", "token-a");

    expect(t.modules.course.whoIs("token-a")?.course.id).toBe(other);
    expect(t.modules.course.whoIs("token-a", courseId)?.course.id).toBe(courseId);
    expect(t.modules.course.whoIs("token-a", aCourse(t, "Unclaimed").id)).toBeNull();
  });
});
