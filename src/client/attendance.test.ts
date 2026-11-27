import { describe, expect, it } from "vitest";
import { checkInLine, lecturerAddresses, windowButton } from "./attendance";

/** A fetch that answers each ipify host with a body, or fails it. */
function fakeFetch(answers: Record<string, string | Error>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const host = new URL(String(input)).host;
    const answer = answers[host];
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error("offline");
    return new Response(answer);
  }) as typeof fetch;
}

describe("the Lecturer's addresses, as the browser sees them", () => {
  it("asks api4 and api6.ipify.org and reports both", async () => {
    const fetcher = fakeFetch({ "api4.ipify.org": "203.0.113.7\n", "api6.ipify.org": "2001:db8::1" });
    expect(await lecturerAddresses(fetcher)).toEqual({ ipv4: "203.0.113.7", ipv6: "2001:db8::1" });
  });

  it("reports a family the network doesn't have as missing", async () => {
    const fetcher = fakeFetch({ "api4.ipify.org": "203.0.113.7", "api6.ipify.org": new Error("no IPv6 route") });
    expect(await lecturerAddresses(fetcher)).toEqual({ ipv4: "203.0.113.7", ipv6: null });
  });

  it("reports both missing when neither answers", async () => {
    expect(await lecturerAddresses(fakeFetch({}))).toEqual({ ipv4: null, ipv6: null });
  });

  it("treats an IPv4 answer from api6 (no IPv6 route, falls back) as no IPv6", async () => {
    const fetcher = fakeFetch({ "api4.ipify.org": "203.0.113.7", "api6.ipify.org": "203.0.113.7" });
    expect(await lecturerAddresses(fetcher)).toEqual({ ipv4: "203.0.113.7", ipv6: null });
  });
});

describe("the Student's Check-in line on Today", () => {
  const at = "2026-11-30T08:18:00.000Z";
  const time = (iso: string) => (iso === at ? "10:18" : "??");

  it("shows the Check-in time when present", () => {
    expect(checkInLine({ status: "present", at }, time).title).toBe("Checked in at 10:18");
  });

  it("says a Pending check-in is waiting for the Lecturer", () => {
    expect(checkInLine({ status: "pending", at }, time).title).toBe(
      "Checked in — waiting for your Lecturer to confirm",
    );
  });

  it("tells a Student to ask the Lecturer once the window has closed", () => {
    expect(checkInLine({ status: "closed", at: null }, time).title).toBe(
      "Check-in is closed — ask the Lecturer to mark you present",
    );
  });

  it("asks for a scan while the window is open, and waits before it opens", () => {
    expect(checkInLine({ status: "open", at: null }, time).title).toBe("Not checked in yet");
    expect(checkInLine({ status: "not-opened", at: null }, time).title).toBe("Check-in hasn’t opened yet");
  });
});

describe("the console's one Check-in window button", () => {
  it("opens, closes, then reopens", () => {
    expect(windowButton("not-opened")).toBe("Open");
    expect(windowButton("open")).toBe("Close");
    expect(windowButton("closed")).toBe("Reopen");
  });
});
