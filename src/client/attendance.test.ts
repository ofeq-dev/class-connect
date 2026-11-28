import { describe, expect, it } from "vitest";
import { checkInLine, dismissedFrom, heldKey, heldPopup, lecturerAddresses, markAfterTap, networkCard, undoMark, whoGroups, windowButton } from "./attendance";

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

  it("says a held scan is waiting for the Lecturer too, in the same tone, without blaming the network", () => {
    const held = checkInLine({ status: "held", at }, time);
    expect(held.title).toBe("Checked in — waiting for your Lecturer to confirm");
    expect(held.tone).toBe(checkInLine({ status: "pending", at }, time).tone);
    expect(held.detail).not.toMatch(/network/);
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

describe("the console's card for a network with Pending check-ins", () => {
  const names = (...n: string[]) => n.map((name, i) => ({ rosterEntryId: i + 1, name }));

  it("names the Students by first name", () => {
    expect(networkCard(names("Ariel Ben-David", "Neta Shapiro"))).toBe(
      "2 Students checked in from another network (Ariel, Neta)",
    );
    expect(networkCard(names("Omar Haddad"))).toBe("1 Student checked in from another network (Omar)");
  });

  it("keeps a long list short", () => {
    expect(networkCard(names("Ariel A", "Neta B", "Dana C", "Omar D", "Irina E", "Noa F"))).toBe(
      "6 Students checked in from another network (Ariel, Neta, Dana, Omar +2)",
    );
  });
});

describe("Who's here", () => {
  const row = (name: string, status: "present" | "waiting" | "absent") => ({ name, status });

  it("splits the Roster into waiting for approval, not here yet and present", () => {
    const groups = whoGroups([row("Dana", "present"), row("Omar", "waiting"), row("Irina", "absent"), row("Noa", "present")]);
    expect(groups.map((g) => [g.title, g.rows.map((r) => r.name)])).toEqual([
      ["Waiting for approval", ["Omar"]],
      ["Not here yet", ["Irina"]],
      ["Present", ["Dana", "Noa"]],
    ]);
  });

  it("leaves out an empty group", () => {
    expect(whoGroups([row("Dana", "present")]).map((g) => g.title)).toEqual(["Present"]);
  });
});

describe("the held-scan popup", () => {
  const dana = { rosterEntryId: 1, name: "Dana Levi", at: "2026-11-30T08:18:00.000Z" };
  const omar = { rosterEntryId: 2, name: "Omar Haddad", at: "2026-11-30T08:19:00.000Z" };

  it("names the first held Student the Lecturer hasn't dismissed", () => {
    expect(heldPopup([dana, omar], new Set())).toBe(dana);
    expect(heldPopup([dana, omar], new Set([heldKey(dana)]))).toBe(omar);
  });

  it("remembers dismissals as saved in the tab, and ignores anything unreadable", () => {
    expect(dismissedFrom(JSON.stringify([heldKey(dana)]))).toEqual(new Set([heldKey(dana)]));
    expect(dismissedFrom(null)).toEqual(new Set());
    expect(dismissedFrom("not json")).toEqual(new Set());
    expect(dismissedFrom('{"a":1}')).toEqual(new Set());
    expect(dismissedFrom('["ok", 3]')).toEqual(new Set(["ok"]));
  });

  it("pops up again for a Student held anew after the Lecturer dismissed an earlier hold", () => {
    const again = { ...dana, at: "2026-11-30T09:00:00.000Z" };
    expect(heldPopup([again], new Set([heldKey(dana)]))).toBe(again);
  });

  it("shows nothing once every held Student is dismissed, or none is held", () => {
    expect(heldPopup([dana, omar], new Set([heldKey(dana), heldKey(omar)]))).toBeNull();
    expect(heldPopup([], new Set())).toBeNull();
  });
});

describe("Manual mark icons", () => {
  it("mark present or absent, and tapping the active icon clears the mark", () => {
    expect(markAfterTap(null, "present")).toBe(true);
    expect(markAfterTap("absent", "present")).toBe(true);
    expect(markAfterTap(null, "absent")).toBe(false);
    expect(markAfterTap("present", "present")).toBeNull();
    expect(markAfterTap("absent", "absent")).toBeNull();
  });

  it("undo puts back the mark there was before", () => {
    expect(undoMark(null)).toBeNull();
    expect(undoMark("present")).toBe(true);
    expect(undoMark("absent")).toBe(false);
  });
});
