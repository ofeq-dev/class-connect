import { useQuery } from "@tanstack/react-query";
import { api, ok } from "../api";
import { diagnosticsQuery, useDiagnostics } from "./diagnostics";
import { useLiveEvents } from "../live";

/** Opens the Course-scoped Live events stream for a Course page. */
export function useCourseLive(courseId: string) {
  useLiveEvents(`/api/lecturer/events?course=${encodeURIComponent(courseId)}`);
}

export function useCourse(courseId: string) {
  return useQuery({
    queryKey: ["course", Number(courseId)],
    queryFn: async () => ok(await api.api.lecturer.courses[":courseId"].$get({ param: { courseId } })),
  });
}

export function useSessions(courseId: string) {
  return useQuery({
    queryKey: ["sessions", Number(courseId)],
    queryFn: async () =>
      ok(await api.api.lecturer.courses[":courseId"].sessions.$get({ param: { courseId } })),
  });
}

export function useRoster(courseId: string) {
  return useQuery({
    queryKey: ["roster", Number(courseId)],
    queryFn: async () => ok(await api.api.lecturer.courses[":courseId"].roster.$get({ param: { courseId } })),
  });
}

/** "Mon 30 Nov" for a YYYY-MM-DD date, without shifting it through a time zone. */
export function formatDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** The console's Attendance query key; attendance.changed refetches every variant by prefix. */
export const attendanceKey = (sessionId: string, diagnostics: boolean) => ["attendance", Number(sessionId), diagnostics];

/** The console's Attendance glance; IPs, blocks and device IDs only while Diagnostics is on. */
export function useAttendance(courseId: string, sessionId: string) {
  const diagnostics = useDiagnostics();
  return useQuery({
    queryKey: attendanceKey(sessionId, diagnostics),
    queryFn: async () =>
      ok(
        await api.api.lecturer.courses[":courseId"].sessions[":sessionId"].attendance.$get({
          param: { courseId, sessionId },
          query: diagnosticsQuery(diagnostics),
        }),
      ),
  });
}

export function useSummaries(courseId: string) {
  return useQuery({
    queryKey: ["summaries", Number(courseId)],
    queryFn: async () =>
      ok(await api.api.lecturer.courses[":courseId"].summaries.$get({ param: { courseId } })),
  });
}

export function useSummary(courseId: string, sessionId: string) {
  return useQuery({
    queryKey: ["summary", Number(sessionId)],
    queryFn: async () =>
      ok(
        await api.api.lecturer.courses[":courseId"].sessions[":sessionId"].summary.$get({
          param: { courseId, sessionId },
        }),
      ),
  });
}

export function useLlmUsage() {
  return useQuery({
    queryKey: ["llm-usage"],
    queryFn: async () => ok(await api.api.lecturer["llm-usage"].$get()),
  });
}

export const SUMMARY_STATE_LABEL = {
  "no-transcript": "No Transcript",
  ready: "Transcript uploaded",
  summarising: "Summarising…",
  failed: "Failed",
  draft: "Draft",
  published: "Published",
} as const;

export function useAssignments(courseId: string) {
  return useQuery({
    queryKey: ["assignments", Number(courseId)],
    queryFn: async () =>
      ok(await api.api.lecturer.courses[":courseId"].assignments.$get({ param: { courseId } })),
  });
}

export function useAssignment(courseId: string, assignmentId: string | undefined) {
  return useQuery({
    queryKey: ["assignment", Number(assignmentId)],
    enabled: !!assignmentId,
    queryFn: async () =>
      ok(
        await api.api.lecturer.courses[":courseId"].assignments[":assignmentId"].$get({
          param: { courseId, assignmentId: assignmentId! },
        }),
      ),
  });
}

/** "Mon 7 Dec, 23:59" for an instant, in the browser's time zone. */
export function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const ASSIGNMENT_STATE_LABEL = {
  open: "Open",
  due: "Due",
  reviewing: "Reviewing",
  reviewed: "Ready to Release",
  released: "Released",
  matched: "Matched",
} as const;

/** The Course's Topics; with archived ones on the Topics screen. */
export function useTopics(courseId: string, includeArchived = false) {
  return useQuery({
    queryKey: ["topics", Number(courseId), includeArchived],
    queryFn: async () =>
      ok(
        await api.api.lecturer.courses[":courseId"].topics.$get({
          param: { courseId },
          query: { archived: includeArchived ? "1" : undefined },
        }),
      ),
  });
}

/** The console's Comments column for one Session; comment.changed refetches it. */
export function useInbox(courseId: string, sessionId: string) {
  return useQuery({
    queryKey: ["comments", "inbox", Number(sessionId)],
    queryFn: async () =>
      ok(
        await api.api.lecturer.courses[":courseId"].sessions[":sessionId"].comments.$get({
          param: { courseId, sessionId },
        }),
      ),
  });
}

export interface CommentQuery {
  topicId?: string;
  author?: string;
  status?: string;
  timing?: string;
}

/** The all-comments screen and the Course desk's section. */
export function useComments(courseId: string, filter: CommentQuery = {}) {
  const query = {
    topicId: filter.topicId || undefined,
    author: filter.author || undefined,
    status: filter.status || undefined,
    timing: filter.timing || undefined,
  };
  return useQuery({
    queryKey: ["comments", "list", Number(courseId), query],
    queryFn: async () =>
      ok(await api.api.lecturer.courses[":courseId"].comments.$get({ param: { courseId }, query })),
  });
}

export type CommentStatus = "new" | "pinned" | "addressed" | "ignored";

export const STATUS_LABEL: Record<CommentStatus, string> = {
  new: "New",
  pinned: "Pinned",
  addressed: "Addressed",
  ignored: "Ignored",
};

/** "10:19" for an instant, in the browser's time zone. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The Course's projector link and what the class sees; projector.changed and attendance.changed refetch it. */
export function useProjector(courseId: string) {
  return useQuery({
    queryKey: ["projector", "course", Number(courseId)],
    queryFn: async () => ok(await api.api.lecturer.courses[":courseId"].projector.$get({ param: { courseId } })),
  });
}

export const projectorUrl = (secret: string) => `${window.location.origin}/p/${secret}`;

/** The console's Polls for one Session; poll.changed refetches them. */
export function useSessionPolls(courseId: string, sessionId: string) {
  return useQuery({
    queryKey: ["polls", Number(sessionId)],
    queryFn: async () =>
      ok(
        await api.api.lecturer.courses[":courseId"].sessions[":sessionId"].polls.$get({
          param: { courseId, sessionId },
        }),
      ),
  });
}

export type LecturerPoll = NonNullable<ReturnType<typeof useSessionPolls>["data"]>[number];

/** The Poll column's one Poll: the focused one, else an open one, else the next scheduled. */
export function currentPoll(polls: LecturerPoll[] | undefined, focus: number | null): LecturerPoll | undefined {
  if (!polls) return undefined;
  return (
    polls.find((p) => p.id === focus) ??
    polls.find((p) => p.status === "open") ??
    polls
      .filter((p) => p.status === "scheduled")
      .sort((a, b) => (a.opensAt ?? "").localeCompare(b.opensAt ?? ""))[0]
  );
}
