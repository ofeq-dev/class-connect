import { useQuery } from "@tanstack/react-query";
import { api, ok } from "../api";
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

export const ASSIGNMENT_STATE_LABEL = { open: "Open", due: "Due" } as const;
