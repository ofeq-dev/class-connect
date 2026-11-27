import { useQuery } from "@tanstack/react-query";
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
