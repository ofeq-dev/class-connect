import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, ok } from "../api";

/** Who this phone is, its Course and today's Session; `{ claimed: false }` for a new phone. */
export function useStudentMe() {
  return useQuery({
    queryKey: ["student", "me"],
    queryFn: async () => ok(await api.api.student.me.$get()),
  });
}

/** The QR entry page's Session and Course, and this phone's Student there if it has claimed. */
export function useQrEntry(code: string) {
  return useQuery({
    queryKey: ["student", "entry", code],
    queryFn: async () => ok(await api.api.student.s[":code"].$get({ param: { code } })),
  });
}

/** "Monday 30 November" for a YYYY-MM-DD date, without shifting it through a time zone. */
export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** The Course's Assignments for Today, by due date, with whether this Student has handed in. */
export function useStudentAssignments() {
  return useQuery({
    queryKey: ["student", "assignments"],
    queryFn: async () => ok(await api.api.student.assignments.$get()),
  });
}

/** One Assignment, with this Student's Submission if any. */
export function useStudentAssignment(assignmentId: string) {
  return useQuery({
    queryKey: ["student", "assignment", Number(assignmentId)],
    queryFn: async () =>
      ok(await api.api.student.assignments[":assignmentId"].$get({ param: { assignmentId } })),
  });
}

/** "Mon 7 Dec, 23:59" for an instant, in the phone's time zone. */
export function dueLabel(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",

  });
}

/** The published Session summaries of this phone's Course, newest Session first. */
export function useStudentSummaries() {
  return useQuery({
    queryKey: ["student", "summaries"],
    queryFn: async () => ok(await api.api.student.summaries.$get()),
  });
}

/**
 * One published Session summary, in `lang` when that translation is ready, else the source
 * language ("" asks for the source). Refetched when the Lecturer publishes or a translation lands.
 */
export function useStudentSummary(sessionId: number, lang: string) {
  return useQuery({
    queryKey: ["student", "summary", sessionId, lang],
    queryFn: async () =>
      ok(
        await api.api.student.summaries[":sessionId"].$get({
          param: { sessionId: String(sessionId) },
          query: { lang },
        }),
      ),
    placeholderData: keepPreviousData,
  });
}

/** Topics to comment on: today's Session first. */
export function useStudentTopics() {
  return useQuery({
    queryKey: ["student", "topics"],
    queryFn: async () => ok(await api.api.student.topics.$get()),
  });
}

/** This Student's own Comments with their status (the Mine tab). */
export function useMyComments() {
  return useQuery({
    queryKey: ["student", "mine"],
    queryFn: async () => ok(await api.api.student.comments.$get()),
  });
}

/** The Polls tab: open Polls to vote on, then past results; poll.changed refetches it. */
export function useStudentPolls(enabled = true) {
  return useQuery({
    queryKey: ["student", "polls"],
    queryFn: async () => ok(await api.api.student.polls.$get()),
    enabled,
  });
}
