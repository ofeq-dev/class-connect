import { eq, inArray } from "drizzle-orm";
import { reactionLabel } from "../../shared/reactions";
import { localInstant, type Clock } from "../clock";
import type { AttendanceModule } from "../attendance";
import type { CourseModule, Session } from "../course";
import type { Db } from "../db";
import { DomainError, NotFoundError } from "../errors";
import type { LiveEvents } from "../live-events";
import { comment as commentTable, topic as topicTable } from "./schema";

export interface Topic {
  id: number;
  courseId: number;
  kind: "general" | "session" | "named";
  /** The Session of a Session Topic, else null. */
  sessionId: number | null;
  /** The Session's date (YYYY-MM-DD) on a Session Topic, else null. */
  sessionDate: string | null;
  name: string;
  archived: boolean;
}

export type CommentStatus = "new" | "pinned" | "addressed" | "ignored";
export type Timing = "before" | "during" | "after";

/** A Comment as its author sees it on the Mine tab. */
export interface MyComment {
  id: number;
  topicId: number;
  topicName: string;
  text: string;
  reaction: string | null;
  anonymous: boolean;
  timing: Timing | null;
  status: CommentStatus;
  createdAt: string;
}

export interface CommentInput {
  /** Typed text; ignored for a quick reaction, whose label is the text. */
  text?: string;
  reaction?: string;
  anonymous?: boolean;
}

/** A Comment in a Lecturer read model: never the author of an anonymous one. */
export interface LecturerComment {
  id: number;
  topicId: number;
  topicName: string;
  text: string;
  reaction: string | null;
  /** Null when the Comment is anonymous. */
  author: { rosterEntryId: number; name: string } | null;
  timing: Timing | null;
  /** Whether the author is checked in to the Topic's Session; null on other Topics. */
  present: boolean | null;
  status: CommentStatus;
  createdAt: string;
}

export interface CommentFilter {
  topicId?: number;
  /** A Roster entry's named Comments, or "anonymous" for every anonymous one. */
  author?: number | "anonymous";
  status?: CommentStatus;
  timing?: Timing;
}

/** Two or more open quick reactions of one kind on one Topic, as one card. */
export interface ReactionGroup {
  kind: "reactions";
  topicId: number;
  topicName: string;
  reaction: string;
  text: string;
  count: number;
  /** The first and the latest reaction's time. */
  from: string;
  to: string;
  /** The named authors ("who?"); anonymous ones are only counted. */
  named: string[];
  anonymous: number;
  /** Group actions apply to all of these. */
  commentIds: number[];
}

export type InboxItem = { kind: "comment"; comment: LecturerComment } | ReactionGroup;

/** The live console's Comments column for one Session. */
export interface Inbox {
  /** Topic filter chips: this Session's Topic, General and the named Topics, with open counts. */
  topics: { id: number; name: string; open: number }[];
  /** Pinned on those Topics, and Pinned from earlier Sessions until Addressed; newest first. */
  pinned: InboxItem[];
  /** New, newest first, quick reactions grouped. */
  open: InboxItem[];
  /** Addressed and Ignored on those Topics, newest first. */
  dealtWith: LecturerComment[];
}

export interface FeedbackModule {
  /**
   * The Course's Topics: today's Session first, then General, the named Topics and the other
   * Sessions newest first. Archived named Topics only when asked for (the Lecturer's Topics screen).
   */
  listTopics(courseId: number, options?: { includeArchived?: boolean }): Topic[];
  /** A Topic of this Course, else NotFoundError. */
  readTopic(courseId: number, topicId: number): Topic;
  addTopic(courseId: number, name: string): Topic;
  /** Named Topics only. */
  renameTopic(courseId: number, topicId: number, name: string): Topic;
  /** Hides a named Topic from Students; its Comments and Polls are kept. */
  archiveTopic(courseId: number, topicId: number): Topic;

  /**
   * A claimed Student's Comment on one of their Course's Topics, typed or a quick reaction.
   * Tagged before / during / after against the Session's start and end on a Session Topic.
   */
  comment(deviceToken: string | undefined, topicId: number, input: CommentInput): MyComment;
  /** The Student's own Comments, newest first; nothing for an unclaimed device. */
  mine(deviceToken: string | undefined): MyComment[];
  /** A Student takes back their own Comment while it is still New. */
  deleteComment(deviceToken: string | undefined, commentId: number): void;
  /** Sets one status on every given Comment of this Course (a quick-reaction group at once). */
  setStatus(courseId: number, commentIds: number[], status: CommentStatus): void;
  /** The Course's Comments, newest first (the all-comments screen). */
  listComments(courseId: number, filter?: CommentFilter): LecturerComment[];
  inbox(sessionId: number): Inbox;
}

export interface FeedbackDeps {
  db: Db;
  clock: Clock;
  events: LiveEvents;
  course: CourseModule;
  attendance: Pick<AttendanceModule, "isPresent">;
  timeZone: string;
}

const MAX_TOPIC_NAME = 60;
const MAX_COMMENT = 1000;

function topicName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new DomainError("topic.name-required", "A Topic needs a name.");
  if (name.length > MAX_TOPIC_NAME) {
    throw new DomainError("topic.name-too-long", `Keep the name under ${MAX_TOPIC_NAME} characters.`);
  }
  return name;
}

const newestFirst = <T extends { createdAt: Date; id: number }>(a: T, b: T) =>
  b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;

export function createFeedbackModule({ db, clock, events, course, attendance, timeZone }: FeedbackDeps): FeedbackModule {
  type TopicRow = typeof topicTable.$inferSelect;

  /** Stores General and each Session's Topic the first time they're listed. */
  function topicRows(courseId: number, sessions: Session[]): TopicRow[] {
    const rows = () => db.select().from(topicTable).where(eq(topicTable.courseId, courseId)).all();
    let all = rows();
    const missing = [
      ...(all.some((r) => r.kind === "general") ? [] : [{ courseId, kind: "general" as const }]),
      ...sessions
        .filter((s) => !all.some((r) => r.kind === "session" && r.sessionId === s.id))
        .map((s) => ({ courseId, kind: "session" as const, sessionId: s.id })),
    ];
    if (missing.length) {
      db.insert(topicTable).values(missing).run();
      all = rows();
    }
    return all;
  }

  function topics(courseId: number): Topic[] {
    const sessions = course.listSessions(courseId);
    const today = course.today();
    const toTopic = (r: TopicRow): Topic | null => {
      const base = { id: r.id, courseId, archived: r.archivedAt !== null, sessionId: null, sessionDate: null };
      if (r.kind === "general") return { ...base, kind: "general", name: "General" };
      if (r.kind === "named") return { ...base, kind: "named", name: r.name ?? "" };
      const index = sessions.findIndex((s) => s.id === r.sessionId);
      const s = sessions[index];
      // A deleted Session's Topic is gone from every list.
      if (!s) return null;
      return { ...base, kind: "session", sessionId: s.id, sessionDate: s.date, name: `Session ${index + 1}` };
    };
    const all = topicRows(courseId, sessions)
      .map(toTopic)
      .filter((x): x is Topic => x !== null);
    const rank = (x: Topic) =>
      x.kind === "session" && x.sessionDate === today ? 0 : x.kind === "general" ? 1 : x.kind === "named" ? 2 : 3;
    const startOf = (x: Topic) => sessions.find((s) => s.id === x.sessionId)?.start ?? "";
    return all.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.kind === "session" ? `${b.sessionDate}${startOf(b)}`.localeCompare(`${a.sessionDate}${startOf(a)}`) : 0) ||
        a.id - b.id,
    );
  }

  function readTopic(courseId: number, topicId: number): Topic {
    const found = topics(courseId).find((x) => x.id === topicId);
    if (!found) throw new NotFoundError("Topic");
    return found;
  }

  function namedTopic(courseId: number, topicId: number): Topic {
    const found = readTopic(courseId, topicId);
    if (found.kind !== "named") {
      throw new DomainError("topic.not-named", "General and Session Topics can't be renamed or archived.");
    }
    return found;
  }

  type CommentRow = typeof commentTable.$inferSelect;

  function timingAt(t: Topic, now: Date): Timing | null {
    if (t.sessionId === null) return null;
    const s = course.readSession(t.sessionId);
    if (now < localInstant(s.date, s.start, timeZone)) return "before";
    if (now <= localInstant(s.date, s.end, timeZone)) return "during";
    return "after";
  }

  const toMine = (r: CommentRow, t: Topic): MyComment => ({
    id: r.id,
    topicId: r.topicId,
    topicName: t.name,
    text: r.text,
    reaction: r.reaction,
    anonymous: r.anonymous,
    timing: r.timing,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  });

  /** Every Comment on the Course's listed Topics (archived included), with its Topic. */
  function courseComments(courseId: number): { row: CommentRow; topic: Topic }[] {
    const byId = new Map(topics(courseId).map((x) => [x.id, x]));
    if (!byId.size) return [];
    return db
      .select()
      .from(commentTable)
      .where(inArray(commentTable.topicId, [...byId.keys()]))
      .all()
      .sort(newestFirst)
      .map((row) => ({ row, topic: byId.get(row.topicId)! }));
  }

  function toLecturer(r: CommentRow, t: Topic, names: Map<number, string>): LecturerComment {
    return {
      id: r.id,
      topicId: r.topicId,
      topicName: t.name,
      text: r.text,
      reaction: r.reaction,
      author: r.anonymous ? null : { rosterEntryId: r.rosterEntryId, name: names.get(r.rosterEntryId) ?? "" },
      timing: r.timing,
      present: t.sessionId === null ? null : attendance.isPresent(t.sessionId, r.rosterEntryId),
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    };
  }

  const rosterNames = (courseId: number) => new Map(course.listRoster(courseId).map((e) => [e.id, e.name]));

  function lecturerComments(courseId: number, filter: CommentFilter = {}): LecturerComment[] {
    const names = rosterNames(courseId);
    return courseComments(courseId)
      .filter(({ row }) => {
        if (filter.topicId !== undefined && row.topicId !== filter.topicId) return false;
        if (filter.status !== undefined && row.status !== filter.status) return false;
        if (filter.timing !== undefined && row.timing !== filter.timing) return false;
        if (filter.author === "anonymous") return row.anonymous;
        // A Student's own filter never includes their anonymous Comments.
        if (filter.author !== undefined) return !row.anonymous && row.rosterEntryId === filter.author;
        return true;
      })
      .map(({ row, topic }) => toLecturer(row, topic, names));
  }

  /** Newest first in, newest first out; a group sits where its latest reaction would. */
  function grouped(comments: LecturerComment[]): InboxItem[] {
    const groups = new Map<string, LecturerComment[]>();
    const order: (LecturerComment | string)[] = [];
    for (const c of comments) {
      if (!c.reaction) {
        order.push(c);
        continue;
      }
      const key = `${c.topicId}|${c.reaction}`;
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key)!.push(c);
    }
    return order.map((entry): InboxItem => {
      if (typeof entry !== "string") return { kind: "comment", comment: entry };
      const members = groups.get(entry)!;
      const first = members[0]!;
      if (members.length === 1) return { kind: "comment", comment: first };
      const named = members.flatMap((m) => (m.author ? [m.author.name] : []));
      return {
        kind: "reactions",
        topicId: first.topicId,
        topicName: first.topicName,
        reaction: first.reaction!,
        text: first.text,
        count: members.length,
        from: members[members.length - 1]!.createdAt,
        to: first.createdAt,
        named: [...new Set(named)].reverse(),
        anonymous: members.filter((m) => !m.author).length,
        commentIds: members.map((m) => m.id),
      };
    });
  }

  /** Comments name a Student, even anonymous ones by their presence note, so only the Lecturer hears. */
  const commentChanged = (courseId: number, id: number) =>
    events.publish(courseId, "lecturer", { type: "comment.changed", id });

  function commentText(input: CommentInput): { text: string; reaction: string | null } {
    if (input.reaction !== undefined) {
      const label = reactionLabel(input.reaction);
      if (!label) throw new DomainError("comment.bad-reaction", "That quick reaction doesn't exist.");
      return { text: label, reaction: input.reaction };
    }
    const text = (input.text ?? "").trim();
    if (!text) throw new DomainError("comment.text-required", "Write something first.");
    if (text.length > MAX_COMMENT) {
      throw new DomainError("comment.too-long", `Keep it under ${MAX_COMMENT} characters.`);
    }
    return { text, reaction: null };
  }

  const topicChanged = (courseId: number, id: number) =>
    events.publish(courseId, "all", { type: "topic.changed", id });

  return {
    listTopics(courseId, options = {}) {
      return topics(courseId).filter((x) => options.includeArchived || !x.archived);
    },

    readTopic,

    addTopic(courseId, raw) {
      const name = topicName(raw);
      const row = db.insert(topicTable).values({ courseId, kind: "named", name }).returning().get();
      topicChanged(courseId, row.id);
      return readTopic(courseId, row.id);
    },

    renameTopic(courseId, topicId, raw) {
      const name = topicName(raw);
      namedTopic(courseId, topicId);
      db.update(topicTable).set({ name }).where(eq(topicTable.id, topicId)).run();
      topicChanged(courseId, topicId);
      return readTopic(courseId, topicId);
    },

    archiveTopic(courseId, topicId) {
      namedTopic(courseId, topicId);
      db.update(topicTable).set({ archivedAt: clock.now() }).where(eq(topicTable.id, topicId)).run();
      topicChanged(courseId, topicId);
      return readTopic(courseId, topicId);
    },

    comment(deviceToken, topicId, input) {
      const row = db.select().from(topicTable).where(eq(topicTable.id, topicId)).get();
      if (!row) throw new NotFoundError("Topic");
      const viewer = deviceToken ? course.whoIs(deviceToken, row.courseId) : null;
      if (!viewer || viewer.course.id !== row.courseId) {
        throw new DomainError("comment.unclaimed", "Scan your Session's QR code first.");
      }
      const t = readTopic(row.courseId, topicId);
      if (t.archived) throw new DomainError("comment.topic-archived", "That Topic is closed.");
      const { text, reaction } = commentText(input);
      const now = clock.now();
      const created = db
        .insert(commentTable)
        .values({
          topicId,
          rosterEntryId: viewer.rosterEntry.id,
          text,
          reaction,
          anonymous: input.anonymous === true,
          timing: timingAt(t, now),
          status: "new",
          createdAt: now,
        })
        .returning()
        .get();
      commentChanged(row.courseId, created.id);
      return toMine(created, t);
    },

    mine(deviceToken) {
      const viewer = deviceToken ? course.whoIs(deviceToken) : null;
      if (!viewer) return [];
      return courseComments(viewer.course.id)
        .filter(({ row }) => row.rosterEntryId === viewer.rosterEntry.id)
        .map(({ row, topic }) => toMine(row, topic));
    },

    deleteComment(deviceToken, commentId) {
      const viewer = deviceToken ? course.whoIs(deviceToken) : null;
      const found = viewer
        ? courseComments(viewer.course.id).find(({ row }) => row.id === commentId)
        : undefined;
      if (!viewer || !found) throw new NotFoundError("Comment");
      if (found.row.rosterEntryId !== viewer.rosterEntry.id) {
        throw new DomainError("comment.not-yours", "You can only delete your own Comments.");
      }
      if (found.row.status !== "new") {
        throw new DomainError("comment.not-new", "The Lecturer has already seen this one.");
      }
      db.delete(commentTable).where(eq(commentTable.id, commentId)).run();
      commentChanged(viewer.course.id, commentId);
    },

    setStatus(courseId, commentIds, status) {
      const ids = [...new Set(commentIds)];
      if (!ids.length) return;
      const ours = new Set(courseComments(courseId).map(({ row }) => row.id));
      if (ids.some((id) => !ours.has(id))) throw new NotFoundError("Comment");
      db.update(commentTable).set({ status }).where(inArray(commentTable.id, ids)).run();
      commentChanged(courseId, ids[0]!);
    },

    listComments: lecturerComments,

    inbox(sessionId) {
      const { courseId } = course.readSession(sessionId);
      const inScope = topics(courseId)
        .filter((x) => !x.archived && (x.kind !== "session" || x.sessionId === sessionId))
        .sort((a, b) => Number(b.kind === "session") - Number(a.kind === "session"));
      const scope = new Set(inScope.map((x) => x.id));
      const all = lecturerComments(courseId);
      const here = all.filter((c) => scope.has(c.topicId));
      const isOpen = (c: LecturerComment) => c.status === "new" || c.status === "pinned";
      return {
        topics: inScope.map((x) => ({ id: x.id, name: x.name, open: here.filter((c) => c.topicId === x.id && isOpen(c)).length })),
        // Pinned carries over from any Topic until it is Addressed (or moved back).
        pinned: grouped(all.filter((c) => c.status === "pinned")),
        open: grouped(here.filter((c) => c.status === "new")),
        dealtWith: here.filter((c) => !isOpen(c)),
      };
    },
  };
}
