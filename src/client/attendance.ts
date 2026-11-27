import type { StudentCheckIn, WindowState } from "../server/attendance";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOOKUP_TIMEOUT = 4000;

async function ask(fetcher: typeof fetch, url: string): Promise<string | null> {
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT), cache: "no-store" });
    if (!res.ok) return null;
    return (await res.text()).trim() || null;
  } catch {
    return null;
  }
}

/**
 * The Lecturer's public addresses, as their own browser reaches the internet (ADR 0001). Each
 * family is asked separately; a network without one simply reports it missing.
 */
export async function lecturerAddresses(
  fetcher: typeof fetch = fetch,
): Promise<{ ipv4: string | null; ipv6: string | null }> {
  const [ipv4, ipv6] = await Promise.all([
    ask(fetcher, "https://api4.ipify.org/"),
    ask(fetcher, "https://api6.ipify.org/"),
  ]);
  return {
    ipv4: ipv4 && IPV4.test(ipv4) ? ipv4 : null,
    ipv6: ipv6 && ipv6.includes(":") ? ipv6 : null,
  };
}

/** "10:18", in the phone's own time zone. */
export const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export type CheckInTone = "ok" | "wait" | "todo" | "bad";

/** The Student's own Check-in line on Today: one spot, whatever the state. */
export function checkInLine(
  { status, at }: StudentCheckIn,
  time: (iso: string) => string = clockTime,
): { title: string; detail: string; tone: CheckInTone } {
  switch (status) {
    case "present":
      return { title: `Checked in at ${at ? time(at) : ""}`.trim(), detail: "You’re marked present.", tone: "ok" };
    case "pending":
      return {
        title: "Checked in — waiting for your Lecturer to confirm",
        detail: "Your phone isn’t on the classroom network. Your Lecturer can approve it.",
        tone: "wait",
      };
    case "closed":
      return {
        title: "Check-in is closed — ask the Lecturer to mark you present",
        detail: "Your Lecturer can still mark you present by hand.",
        tone: "bad",
      };
    case "open":
      return { title: "Not checked in yet", detail: "Scan the code on the board with your phone camera.", tone: "todo" };
    case "not-opened":
      return {
        title: "Check-in hasn’t opened yet",
        detail: "When your Lecturer opens it, scan the code on the board.",
        tone: "todo",
      };
  }
}

/** The console's one window button: Open, then Close, then Reopen. */
export function windowButton(state: WindowState): string {
  return { "not-opened": "Open check-in", open: "Close check-in", closed: "Reopen check-in" }[state];
}
