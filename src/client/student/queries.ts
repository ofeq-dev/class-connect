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
