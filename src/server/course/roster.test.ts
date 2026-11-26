import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, NotFoundError } from "../errors";
import { aCourse, aRoster, makeTestApp, type TestApp } from "../testing";

let t: TestApp;
let courseId: number;
beforeEach(() => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  t.fakes.events.clear();
});
afterEach(() => t.close());

const roster = () => t.modules.course.listRoster(courseId).map((e) => [e.studentId, e.name]);

describe("Roster import", () => {
  it("adds one Roster entry per row, with or without a header, in either column order", () => {
    const report = t.modules.course.importRoster(courseId, "Name,Student ID\nDana Levi,1001\nOmar Haddad,1002\n");
    expect(report).toEqual({ added: 2, alreadyOnRoster: 0, problems: [] });

    t.modules.course.importRoster(courseId, "1003,Irina Petrova\r\n1004;Noa Cohen");
    expect(roster()).toEqual([
      ["1001", "Dana Levi"],
      ["1004", "Noa Cohen"],
      ["1002", "Omar Haddad"],
      ["1003", "Irina Petrova"],
    ].sort((a, b) => a[1]!.localeCompare(b[1]!)));
  });

  it("reads quoted names with commas, Hebrew headers and a byte-order mark", () => {
    t.modules.course.importRoster(courseId, '﻿שם,ת"ז\n"Levi, Dana",1001\n');
    expect(roster()).toEqual([["1001", "Levi, Dana"]]);
  });

  it("reports bad rows with their line number instead of dropping them silently", () => {
    const report = t.modules.course.importRoster(
      courseId,
      "Name,Student ID\nDana Levi,1001\n,1002\nOmar Haddad,\nNoa Cohen,1001\n",
    );
    expect(report.added).toBe(1);
    expect(report.problems).toEqual([
      { line: 3, reason: "No name.", raw: ", 1002" },
      { line: 4, reason: "No student ID.", raw: "Omar Haddad, " },
      { line: 5, reason: "Student ID 1001 appears twice in this file.", raw: "Noa Cohen, 1001" },
    ]);
  });

  it("doesn't duplicate student IDs already on the Roster when imported again", () => {
    t.modules.course.importRoster(courseId, "Dana Levi,1001\nOmar Haddad,1002");
    const again = t.modules.course.importRoster(courseId, "Dana Levi,1001\nOmar Haddad,1002\nNoa Cohen,1003");
    expect(again).toEqual({ added: 1, alreadyOnRoster: 2, problems: [] });
    expect(roster()).toHaveLength(3);
  });

  it("notifies the Lecturer once per import that added Students, and not otherwise", () => {
    t.modules.course.importRoster(courseId, "Dana Levi,1001\nOmar Haddad,1002");
    t.modules.course.importRoster(courseId, "Dana Levi,1001");
    expect(t.fakes.events.published).toEqual([
      { courseId, audience: "lecturer", notice: { type: "roster.changed", id: courseId } },
    ]);
  });
});

describe("Roster entries", () => {
  it("adds a single Student by hand and refuses a duplicate student ID", () => {
    const entry = t.modules.course.addRosterEntry(courseId, " 1001 ", "  Dana   Levi ");
    expect(entry).toMatchObject({ studentId: "1001", name: "Dana Levi", claimed: false, claimedAt: null });
    expect(() => t.modules.course.addRosterEntry(courseId, "1001", "Someone Else")).toThrow(DomainError);
    expect(() => t.modules.course.addRosterEntry(courseId, "", "No ID")).toThrow(DomainError);
  });

  it("keeps each Course's Roster separate", () => {
    const other = aCourse(t, "Algorithms").id;
    aRoster(t, courseId, 2);
    t.modules.course.addRosterEntry(other, "1001", "Same ID, other Course");
    expect(t.modules.course.listRoster(other)).toHaveLength(1);
    expect(t.modules.course.findRosterEntry(other, "1002")).toBeNull();
  });

  it("finds an entry by student ID for the confirm step", () => {
    aRoster(t, courseId, 2);
    expect(t.modules.course.findRosterEntry(courseId, "1002")?.name).toBe("Omar Haddad");
    expect(t.modules.course.findRosterEntry(courseId, "9999")).toBeNull();
  });

  it("resets a Claim only on the Course's own entries", () => {
    const [entry] = aRoster(t, courseId, 1);
    expect(t.modules.course.resetClaim(courseId, entry!.id).claimed).toBe(false);
    const other = aCourse(t, "Algorithms").id;
    expect(() => t.modules.course.resetClaim(other, entry!.id)).toThrow(NotFoundError);
  });
});
