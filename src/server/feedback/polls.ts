import { and, eq, inArray } from "drizzle-orm";
import type { Clock } from "../clock";
import type { CourseModule } from "../course";
import type { Db } from "../db";
import { DomainError, NotFoundError } from "../errors";
import type { LiveEvents } from "../live-events";
import { poll as pollTable, pollOption, vote as voteTable } from "./schema";
import type { Topic } from "./index";

/**
 * Worked out from the Poll's times and the Clock: "draft" (not opening by itself), "scheduled"
 * (opens at a set time), "open", or "closed" (for good).
 */
export type PollStatus = "draft" | "scheduled" | "open" | "closed";

export interface PollInput {
  topicId: number;
  question: string;
  /** Up to six; blank ones are dropped. Two or more are needed to open. */
  options: string[];
  /** "now" opens it at once; a time schedules it; null or absent leaves it a draft. */
  opensAt?: Date | "now" | null;
  /** Closes by itself this long after it opens; null or absent: when the Lecturer closes it. */
  closeAfterMinutes?: number | null;
}

interface PollBase {
  id: number;
  question: string;
  status: PollStatus;
}

/** The Lecturer's view: live totals, never who voted. */
export interface LecturerPoll extends PollBase {
  topicId: number;
  topicName: string;
  /** A question and at least two options: the Poll may open. */
  complete: boolean;
  /** When it opens (or opened), and when it closes (or closed); null when not set. */
  opensAt: string | null;
  closesAt: string | null;
  closeAfterMinutes: number | null;
  votes: number;
  options: { id: number; label: string; votes: number }[];
}

/** A Student's view: their own Vote, and the totals only once the Poll has closed. */
export interface StudentPoll extends PollBase {
  topicName: string;
  myVote: number | null;
  votes: number | null;
  options: { id: number; label: string; votes: number | null }[];
}

/** The Projector window's view: the question, options and vote count; totals once closed. */
export interface ProjectorPoll extends PollBase {
  votes: number;
  options: { id: number; label: string; votes: number | null }[];
}

export type PollViewer = "lecturer" | "projector" | { rosterEntryId: number };
export type PollResults<V extends PollViewer> = V extends "lecturer"
  ? LecturerPoll
  : V extends "projector"
    ? ProjectorPoll
    : StudentPoll;

export interface PollOps {
  createPoll(courseId: number, input: PollInput): LecturerPoll;
  /** Rewrites a Poll that hasn't opened yet (finishing a draft, or moving its schedule). */
  updatePoll(courseId: number, pollId: number, input: PollInput): LecturerPoll;
  openPoll(courseId: number, pollId: number): LecturerPoll;
  /** Closes an open Poll for good; there is no reopen. */
  closePoll(courseId: number, pollId: number): LecturerPoll;
  /** A new draft with the same Topic, question and options (the way to run a closed Poll again). */
  copyPoll(courseId: number, pollId: number): LecturerPoll;
  /** One Vote per Roster entry; voting again changes it. Refused unless the Poll is open. */
  vote(pollId: number, rosterEntryId: number, optionId: number): void;
  results<V extends PollViewer>(courseId: number, pollId: number, viewer: V): PollResults<V>;
  /** The console's Polls: this Session's Topic, General and named Topics; oldest first. */
  sessionPolls(sessionId: number): LecturerPoll[];
  /** A Student's Polls tab: open ones (oldest first), then closed ones' results (newest first). */
  studentPolls(courseId: number, rosterEntryId: number): { open: StudentPoll[]; closed: StudentPoll[] };
  /** The earliest scheduled open or close strictly after `after`, for the next-event timer. */
  nextMoment(after: Date): Date | null;
  /** Publishes poll.changed for every scheduled open or close in (since, until]; changes nothing. */
  announce(since: Date, until: Date): void;
}

interface PollDeps {
  db: Db;
  clock: Clock;
  events: LiveEvents;
  course: CourseModule;
  topics: (courseId: number) => Topic[];
  readTopic: (courseId: number, topicId: number) => Topic;
  /** The Course a Topic belongs to. */
  topicCourse: (topicId: number) => number;
  scheduleChanged: () => void;
}

const MAX_OPTIONS = 6;
const MAX_QUESTION = 200;
const MAX_OPTION = 80;
const MIN = 60_000;

type PollRow = typeof pollTable.$inferSelect;
type OptionRow = typeof pollOption.$inferSelect;

const earliest = (...dates: (Date | null)[]) => {
  const set = dates.filter((d): d is Date => d !== null);
  return set.length ? new Date(Math.min(...set.map((d) => d.getTime()))) : null;
};

/** When a Poll opens and closes: a manual action wins, because it is always the earlier one. */
function moments(row: PollRow) {
  const opensAt = earliest(row.openedAt, row.scheduledOpenAt);
  const closesAt = earliest(
    row.closedAt,
    opensAt && row.closeAfterMinutes !== null ? new Date(opensAt.getTime() + row.closeAfterMinutes * MIN) : null,
  );
  return { opensAt, closesAt };
}

function statusAt(row: PollRow, now: Date): PollStatus {
  const { opensAt, closesAt } = moments(row);
  if (!opensAt || now < opensAt) return row.scheduledOpenAt ? "scheduled" : "draft";
  if (closesAt && now >= closesAt) return "closed";
  return "open";
}

function cleanInput(input: PollInput) {
  const question = input.question.trim();
  const options = input.options.map((o) => o.trim()).filter(Boolean);
  if (options.length > MAX_OPTIONS) {
    throw new DomainError("poll.too-many-options", `A Poll has at most ${MAX_OPTIONS} answers.`);
  }
  if (question.length > MAX_QUESTION) {
    throw new DomainError("poll.question-too-long", `Keep the question under ${MAX_QUESTION} characters.`);
  }
  if (options.some((o) => o.length > MAX_OPTION)) {
    throw new DomainError("poll.option-too-long", `Keep each answer under ${MAX_OPTION} characters.`);
  }
  const minutes = input.closeAfterMinutes ?? null;
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60)) {
    throw new DomainError("poll.bad-duration", "Close after a whole number of minutes.");
  }
  return { question, options, minutes, complete: question.length > 0 && options.length >= 2 };
}

const incomplete = () =>
  new DomainError("poll.incomplete", "A Poll needs a question and two answers before it can open.");

export function createPollOps({ db, clock, events, course, topics, readTopic, topicCourse, scheduleChanged }: PollDeps): PollOps {
  function optionRows(pollIds: number[]): OptionRow[] {
    if (!pollIds.length) return [];
    return db.select().from(pollOption).where(inArray(pollOption.pollId, pollIds)).all();
  }

  function voteRows(pollIds: number[]) {
    if (!pollIds.length) return [];
    return db.select().from(voteTable).where(inArray(voteTable.pollId, pollIds)).all();
  }

  /** The Poll if it is on a Topic of this Course, with its Topic; else NotFoundError. */
  function ownPoll(courseId: number, pollId: number): { row: PollRow; topic: Topic } {
    const row = db.select().from(pollTable).where(eq(pollTable.id, pollId)).get();
    const topic = row && topics(courseId).find((x) => x.id === row.topicId);
    if (!row || !topic) throw new NotFoundError("Poll");
    return { row, topic };
  }

  function views(rows: { row: PollRow; topic: Topic }[], viewer: PollViewer) {
    const ids = rows.map((r) => r.row.id);
    const options = optionRows(ids).sort((a, b) => a.position - b.position);
    const votes = voteRows(ids);
    const now = clock.now();
    return rows.map(({ row, topic }) => {
      const status = statusAt(row, now);
      const mine = options.filter((o) => o.pollId === row.id);
      const cast = votes.filter((v) => v.pollId === row.id);
      const count = (optionId: number) => cast.filter((v) => v.optionId === optionId).length;
      const base = { id: row.id, question: row.question, status };
      if (viewer === "lecturer") {
        const { opensAt, closesAt } = moments(row);
        return {
          ...base,
          topicId: topic.id,
          topicName: topic.name,
          complete: row.question.length > 0 && mine.length >= 2,
          opensAt: opensAt?.toISOString() ?? null,
          closesAt: closesAt?.toISOString() ?? null,
          closeAfterMinutes: row.closeAfterMinutes,
          votes: cast.length,
          options: mine.map((o) => ({ id: o.id, label: o.label, votes: count(o.id) })),
        } satisfies LecturerPoll;
      }
      const closed = status === "closed";
      const options2 = mine.map((o) => ({ id: o.id, label: o.label, votes: closed ? count(o.id) : null }));
      if (viewer === "projector") return { ...base, votes: cast.length, options: options2 } satisfies ProjectorPoll;
      return {
        ...base,
        topicName: topic.name,
        myVote: cast.find((v) => v.rosterEntryId === viewer.rosterEntryId)?.optionId ?? null,
        votes: closed ? cast.length : null,
        options: options2,
      } satisfies StudentPoll;
    });
  }

  function view<V extends PollViewer>(courseId: number, pollId: number, viewer: V): PollResults<V> {
    return views([ownPoll(courseId, pollId)], viewer)[0] as PollResults<V>;
  }

  /** Open and close are for everyone; the projector hears too, but only ever reads counts. */
  function changed(courseId: number, pollId: number, audience: "all" | "lecturer", projector: boolean) {
    events.publish(courseId, audience, { type: "poll.changed", id: pollId });
    if (projector) events.publish(courseId, "projector", { type: "poll.changed", id: pollId });
  }

  function writableTopic(courseId: number, topicId: number) {
    const topic = readTopic(courseId, topicId);
    if (topic.archived) throw new DomainError("poll.topic-archived", "That Topic is archived.");
    return topic;
  }

  /** Writes the Poll's fields and options; returns its id. */
  function write(courseId: number, input: PollInput, existing?: PollRow): number {
    writableTopic(courseId, input.topicId);
    const clean = cleanInput(input);
    const opens = input.opensAt ?? null;
    if (opens !== null && !clean.complete) throw incomplete();
    const now = clock.now();
    const opensNow = opens === "now" || (opens instanceof Date && opens <= now);
    const fields = {
      topicId: input.topicId,
      question: clean.question,
      scheduledOpenAt: opens instanceof Date && !opensNow ? opens : null,
      closeAfterMinutes: clean.minutes,
      openedAt: opensNow ? now : null,
    };
    return db.transaction(() => {
      const id = existing
        ? (db.update(pollTable).set(fields).where(eq(pollTable.id, existing.id)).run(), existing.id)
        : db.insert(pollTable).values({ ...fields, createdAt: now }).returning().get().id;
      if (existing) db.delete(pollOption).where(eq(pollOption.pollId, id)).run();
      if (clean.options.length) {
        db.insert(pollOption)
          .values(clean.options.map((label, position) => ({ pollId: id, label, position })))
          .run();
      }
      return id;
    });
  }

  function afterWrite(courseId: number, pollId: number) {
    const { row } = ownPoll(courseId, pollId);
    const open = statusAt(row, clock.now()) === "open";
    changed(courseId, pollId, open ? "all" : "lecturer", open);
    scheduleChanged();
    return view(courseId, pollId, "lecturer");
  }

  return {
    createPoll(courseId, input) {
      return afterWrite(courseId, write(courseId, input));
    },

    updatePoll(courseId, pollId, input) {
      const { row } = ownPoll(courseId, pollId);
      const status = statusAt(row, clock.now());
      if (status !== "draft" && status !== "scheduled") {
        throw new DomainError("poll.not-draft", "A Poll that has opened can't be edited; copy it instead.");
      }
      return afterWrite(courseId, write(courseId, input, row));
    },

    openPoll(courseId, pollId) {
      const { row } = ownPoll(courseId, pollId);
      const status = statusAt(row, clock.now());
      if (status === "open") return view(courseId, pollId, "lecturer");
      if (status === "closed") throw new DomainError("poll.closed", "A closed Poll can't reopen; copy it instead.");
      if (!view(courseId, pollId, "lecturer").complete) throw incomplete();
      db.update(pollTable).set({ openedAt: clock.now() }).where(eq(pollTable.id, pollId)).run();
      changed(courseId, pollId, "all", true);
      scheduleChanged();
      return view(courseId, pollId, "lecturer");
    },

    closePoll(courseId, pollId) {
      const { row } = ownPoll(courseId, pollId);
      if (statusAt(row, clock.now()) !== "open") throw new DomainError("poll.not-open", "That Poll isn't open.");
      db.update(pollTable).set({ closedAt: clock.now() }).where(eq(pollTable.id, pollId)).run();
      changed(courseId, pollId, "all", true);
      scheduleChanged();
      return view(courseId, pollId, "lecturer");
    },

    copyPoll(courseId, pollId) {
      const source = view(courseId, pollId, "lecturer");
      const topicId = readTopic(courseId, source.topicId).archived ? undefined : source.topicId;
      if (topicId === undefined) throw new DomainError("poll.topic-archived", "That Poll's Topic is archived.");
      return afterWrite(
        courseId,
        write(courseId, { topicId, question: source.question, options: source.options.map((o) => o.label) }),
      );
    },

    vote(pollId, rosterEntryId, optionId) {
      const row = db.select().from(pollTable).where(eq(pollTable.id, pollId)).get();
      if (!row) throw new NotFoundError("Poll");
      const courseId = topicCourse(row.topicId);
      if (!course.listRoster(courseId).some((e) => e.id === rosterEntryId)) throw new NotFoundError("Roster entry");
      if (statusAt(row, clock.now()) !== "open") throw new DomainError("vote.not-open", "This Poll has closed.");
      const option = db
        .select()
        .from(pollOption)
        .where(and(eq(pollOption.id, optionId), eq(pollOption.pollId, pollId)))
        .get();
      if (!option) throw new DomainError("vote.bad-option", "That answer isn't on this Poll.");
      const at = clock.now();
      db.insert(voteTable)
        .values({ pollId, rosterEntryId, optionId, at })
        .onConflictDoUpdate({ target: [voteTable.pollId, voteTable.rosterEntryId], set: { optionId, at } })
        .run();
      changed(courseId, pollId, "lecturer", true);
    },

    results: view,

    sessionPolls(sessionId) {
      const { courseId } = course.readSession(sessionId);
      const scope = topics(courseId).filter((x) => x.kind !== "session" || x.sessionId === sessionId);
      return views(pollsOn(scope), "lecturer") as LecturerPoll[];
    },

    studentPolls(courseId, rosterEntryId) {
      const all = views(pollsOn(topics(courseId)), { rosterEntryId }) as StudentPoll[];
      const closedAt = new Map(pollsOn(topics(courseId)).map(({ row }) => [row.id, moments(row).closesAt?.getTime() ?? 0]));
      return {
        open: all.filter((p) => p.status === "open"),
        closed: all
          .filter((p) => p.status === "closed")
          .sort((a, b) => closedAt.get(b.id)! - closedAt.get(a.id)! || b.id - a.id),
      };
    },

    nextMoment(after) {
      const future = livePolls()
        .flatMap((row) => {
          const { opensAt, closesAt } = moments(row);
          return [row.openedAt ? null : opensAt, row.closedAt ? null : closesAt];
        })
        .filter((d): d is Date => d !== null && d > after);
      return earliest(...future);
    },

    announce(since, until) {
      for (const row of livePolls()) {
        const { opensAt, closesAt } = moments(row);
        const scheduled = [row.openedAt ? null : opensAt, row.closedAt ? null : closesAt];
        if (scheduled.some((d) => d !== null && d > since && d <= until)) {
          changed(topicCourse(row.topicId), row.id, "all", true);
        }
      }
    },
  };

  function pollsOn(scope: Topic[]): { row: PollRow; topic: Topic }[] {
    const byId = new Map(scope.map((x) => [x.id, x]));
    if (!byId.size) return [];
    return db
      .select()
      .from(pollTable)
      .where(inArray(pollTable.topicId, [...byId.keys()]))
      .all()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)
      .map((row) => ({ row, topic: byId.get(row.topicId)! }));
  }

  /** Polls with something still to happen by schedule: not closed by hand. */
  function livePolls(): PollRow[] {
    return db
      .select()
      .from(pollTable)
      .all()
      .filter((row) => row.closedAt === null && (row.scheduledOpenAt !== null || row.closeAfterMinutes !== null));
  }
}
