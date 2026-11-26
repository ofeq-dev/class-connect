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
