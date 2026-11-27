import { asc, eq, inArray } from "drizzle-orm";
import type { Clock } from "../clock";
import type { CourseModule } from "../course";
import type { Db } from "../db";
import { DomainError, NotFoundError } from "../errors";
import type { Job, Jobs } from "../jobs";
import type { Level } from "../../shared/homework";
import type {
  Assignment,
  Criterion,
  HelpState,
  LecturerHelp,
  ReviewLevel,
  StudentAssignment,
  StudentRef,
} from "./index";
import {
  assignment as assignmentTable,
  helpMatch,
  helpOffer,
  helpRequest,
  review as reviewTable,
  submission as submissionTable,
} from "./schema";

/** A Helper takes at most this many Help requests per Criterion. */
export const MAX_MATCHES_PER_HELPER = 2;

/** What Help matching reads from the rest of the Homework module. */
export interface HelpContext {
  db: Db;
  clock: Clock;
  course: CourseModule;
  jobs: Jobs;
  assignmentRow(assignmentId: number): typeof assignmentTable.$inferSelect;
  criteriaOf(assignmentId: number): Criterion[];
  studentOn(courseId: number, rosterEntryId: number): unknown;
  submissionRow(assignmentId: number, rosterEntryId: number): typeof submissionTable.$inferSelect | undefined;
  reviewsOf(
    submissionIds: number[],
    criteria: Criterion[],
  ): Map<number, { review: typeof reviewTable.$inferSelect; levels: ReviewLevel[] }>;
  changed(courseId: number, assignmentId: number, audience?: "all" | "lecturer"): void;
}

/**
 * Help requests, offers and the one matching pass (`help.match`), with no LLM. Registers the
 * job handler; returns the read models and the check behind requestHelp / offerHelp.
 */
export function createHelp(ctx: HelpContext) {
  const { db, clock, course, jobs, assignmentRow, criteriaOf, studentOn, submissionRow, reviewsOf, changed } = ctx;

  function helpRows(assignmentId: number) {
    const ids = criteriaOf(assignmentId).map((c) => c.id);
    if (ids.length === 0) return { requests: [], offers: [], matches: [] };
    const requests = db
      .select()
      .from(helpRequest)
      .where(inArray(helpRequest.criterionId, ids))
      .orderBy(asc(helpRequest.createdAt), asc(helpRequest.id))
      .all();
    const offers = db
      .select()
      .from(helpOffer)
      .where(inArray(helpOffer.criterionId, ids))
      .orderBy(asc(helpOffer.createdAt), asc(helpOffer.id))
      .all();
    const matches = requests.length
      ? db.select().from(helpMatch).where(inArray(helpMatch.helpRequestId, requests.map((r) => r.id))).all()
      : [];
    return { requests, offers, matches };
  }

  function lecturerHelp(assignment: Assignment, roster: Map<number, { name: string }>): LecturerHelp {
    const { requests, offers, matches } = helpRows(assignment.id);
    const ref = (rosterEntryId: number): StudentRef => ({
      rosterEntryId,
      name: roster.get(rosterEntryId)?.name ?? "Unknown Student",
    });
    const label = new Map(assignment.criteria.map((c) => [c.id, c.label]));
    const position = new Map(assignment.criteria.map((c, i) => [c.id, i]));
    const offerById = new Map(offers.map((o) => [o.id, o]));
    const helperOf = new Map(matches.map((m) => [m.helpRequestId, offerById.get(m.helpOfferId)!]));
    return {
      requests: requests.map((r) => ({
        id: r.id,
        criterionId: r.criterionId,
        criterion: label.get(r.criterionId) ?? "",
        student: ref(r.rosterEntryId),
        level: r.level as Level,
        createdAt: r.createdAt.toISOString(),
        helper: helperOf.has(r.id) ? ref(helperOf.get(r.id)!.rosterEntryId) : null,
      })),
      offers: offers.map((o) => ({
        id: o.id,
        criterionId: o.criterionId,
        criterion: label.get(o.criterionId) ?? "",
        student: ref(o.rosterEntryId),
        createdAt: o.createdAt.toISOString(),
        matched: requests.filter((r) => helperOf.get(r.id)?.id === o.id).map((r) => ref(r.rosterEntryId)),
      })),
      matches: requests
        .filter((r) => helperOf.has(r.id))
        .sort((a, b) => position.get(a.criterionId)! - position.get(b.criterionId)!)
        .map((r) => ({
          criterionId: r.criterionId,
          criterion: label.get(r.criterionId) ?? "",
          student: ref(r.rosterEntryId),
          helper: ref(helperOf.get(r.id)!.rosterEntryId),
        })),
    };
  }

  /** The Student's Help per Criterion; needs their own released Review. */
  function studentHelp(
    row: typeof assignmentTable.$inferSelect,
    assignment: Assignment,
    rosterEntryId: number,
    levels: ReviewLevel[],
  ): StudentAssignment["help"] {
    const roster = new Map(course.listRoster(row.courseId).map((e) => [e.id, e.name]));
    const { requests, offers, matches } = helpRows(assignment.id);
    const nameOf = (id: number) => roster.get(id) ?? "Unknown Student";
    const offerById = new Map(offers.map((o) => [o.id, o]));
    const requestById = new Map(requests.map((r) => [r.id, r]));
    const matched = row.matchedAt !== null;
    return assignment.criteria.map((c) => {
      const level = levels.find((l) => l.criterionId === c.id)?.level;
      const mineAsk = requests.find((r) => r.criterionId === c.id && r.rosterEntryId === rosterEntryId);
      const mineOffer = offers.find((o) => o.criterionId === c.id && o.rosterEntryId === rosterEntryId);
      let state: HelpState;
      if (mineAsk) {
        const m = matches.find((x) => x.helpRequestId === mineAsk.id);
        state = m
          ? { kind: "paired", with: [nameOf(offerById.get(m.helpOfferId)!.rosterEntryId)] }
          : matched
            ? { kind: "no-helper" }
            : { kind: "asked" };
      } else if (mineOffer) {
        const helped = matches
          .filter((x) => x.helpOfferId === mineOffer.id)
          .map((x) => nameOf(requestById.get(x.helpRequestId)!.rosterEntryId));
        state = helped.length ? { kind: "paired", with: helped } : matched ? { kind: "thanks" } : { kind: "offered" };
      } else if (matched || !level) {
        state = { kind: "closed" };
      } else {
        state = level === "secure" ? { kind: "can-offer" } : { kind: "can-ask" };
      }
      return { criterionId: c.id, label: c.label, state };
    });
  }

  /**
   * Checks the Student may ask or offer on the Criterion now, and returns their released level on it:
   * after Release, before matching, with their own Review released.
   */
  function helpLevel(assignmentId: number, criterionId: number, rosterEntryId: number) {
    const row = assignmentRow(assignmentId);
    studentOn(row.courseId, rosterEntryId);
    if (!row.releasedAt) throw new DomainError("help.not-released", "Help opens once the Assignment is Released.");
    if (row.matchedAt) throw new DomainError("help.matched", "Help matching has run, so Help is closed.");
    const criteria = criteriaOf(assignmentId);
    if (!criteria.some((c) => c.id === criterionId)) throw new NotFoundError("Criterion");
    const mine = submissionRow(assignmentId, rosterEntryId);
    const written = mine ? reviewsOf([mine.id], criteria).get(mine.id) : undefined;
    if (!written?.review.releasedAt) {
      throw new DomainError("help.no-review", "Help opens once your Review is released.");
    }
    return { row, level: written.levels.find((l) => l.criterionId === criterionId)!.level };
  }

  /**
   * The one matching pass: Not yet before Partly, earliest first; each request to the Helper on
   * its Criterion with the fewest matches so far in this pass (across the Assignment), the
   * earliest offer on a tie, with at most MAX_MATCHES_PER_HELPER per Helper per Criterion.
   */
  function matchHelp(assignmentId: number): { helpRequestId: number; helpOfferId: number }[] {
    const { requests, offers } = helpRows(assignmentId);
    const rank = (level: string) => (level === "not-yet" ? 0 : 1);
    const queue = [...requests].sort((a, b) => rank(a.level) - rank(b.level)); // stable: earliest first within a level
    const perOffer = new Map<number, number>();
    const perHelper = new Map<number, number>();
    const out: { helpRequestId: number; helpOfferId: number }[] = [];
    for (const r of queue) {
      let best: (typeof offers)[number] | undefined;
      for (const o of offers) {
        if (o.criterionId !== r.criterionId || o.rosterEntryId === r.rosterEntryId) continue;
        if ((perOffer.get(o.id) ?? 0) >= MAX_MATCHES_PER_HELPER) continue;
        if (!best || (perHelper.get(o.rosterEntryId) ?? 0) < (perHelper.get(best.rosterEntryId) ?? 0)) best = o;
      }
      if (!best) continue;
      out.push({ helpRequestId: r.id, helpOfferId: best.id });
      perOffer.set(best.id, (perOffer.get(best.id) ?? 0) + 1);
      perHelper.set(best.rosterEntryId, (perHelper.get(best.rosterEntryId) ?? 0) + 1);
    }
    return out;
  }

  async function handleHelpMatch(job: Job<"help.match">) {
    const { assignmentId } = job.payload;
    const row = db.select().from(assignmentTable).where(eq(assignmentTable.id, assignmentId)).get();
    if (!row) return;
    let ran = false;
    jobs.complete(job, () => {
      // The deadline job after Match now, or a second Match now, finds matched_at set and stops.
      const current = assignmentRow(assignmentId);
      if (!current.releasedAt || current.matchedAt) return;
      for (const m of matchHelp(assignmentId)) db.insert(helpMatch).values(m).run();
      db.update(assignmentTable).set({ matchedAt: clock.now() }).where(eq(assignmentTable.id, assignmentId)).run();
      ran = true;
    });
    if (ran) changed(row.courseId, assignmentId);
  }

  jobs.register("help.match", handleHelpMatch);

  return { lecturerHelp, studentHelp, helpLevel };
}
