import { clockTime } from "../time";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { HeldStudent, LecturerAttendance, WhoRow } from "../../server/attendance";
import { api, ok } from "../api";
import { dismissedFrom, heldKey, heldPopup, lecturerAddresses, markAfterTap, networkCard, undoMark, whoGroups, windowButton } from "../attendance";
import { diagnosticsQuery, useDiagnostics } from "./diagnostics";
import { CheckIcon, ChevronIcon, CrossIcon } from "./icons";
import { attendanceKey, useAttendance } from "./queries";

const UNDO_FOR = 8000;

/** The last Manual mark, offered back for Undo for a few seconds. */
interface Undo {
  rosterEntryId: number;
  name: string;
  before: WhoRow["mark"];
  said: string;
}

/**
 * The console's Attendance column: the big "19 of 32 present", whether Check-in is open with its
 * one Open / Close / Reopen button, one orange card per network with Pending check-ins
 * (Approve network), held scans (a scan after a Manual ✕: a popup, then a list kept for after
 * class, each with Allow / Keep absent), and "Who's here" with ✓ / ✕ Manual mark icons and Undo.
 * Every Check-in sends attendance.changed to the Lecturer's stream, which refetches it.
 */
export function AttendanceColumn({ courseId, sessionId }: { courseId: string; sessionId: string }) {
  const client = useQueryClient();
  const diagnostics = useDiagnostics();
  const attendance = useAttendance(courseId, sessionId);
  const param = { courseId, sessionId };
  const query = diagnosticsQuery(diagnostics);
  const route = api.api.lecturer.courses[":courseId"].sessions[":sessionId"].attendance;
  const [whoOpen, setWhoOpen] = useState(false);
  const [undo, setUndo] = useState<Undo | null>(null);
  /** Held scans whose popup the Lecturer closed ("Later"), kept for this tab; they stay in the held list. */
  const dismissedKey = `cc.held-dismissed.${sessionId}`;
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => {
    try {
      return dismissedFrom(sessionStorage.getItem(dismissedKey));
    } catch {
      return new Set();
    }
  });
  function dismiss(h: HeldStudent) {
    const next = new Set(dismissed).add(heldKey(h));
    setDismissed(next);
    try {
      sessionStorage.setItem(dismissedKey, JSON.stringify([...next]));
    } catch {
      // Storage blocked: the dismissal lasts until the page reloads.
    }
  }

  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), UNDO_FOR);
    return () => clearTimeout(timer);
  }, [undo]);

  const store = (data: LecturerAttendance) => client.setQueryData(attendanceKey(sessionId, diagnostics), data);

  const toggle = useMutation({
    mutationFn: async (action: "open" | "close") => {
      if (action === "close") return ok(await route.window.close.$post({ param, query }));
      // The browser asks for its own public addresses: the Classroom network is wherever this laptop is.
      return ok(await route.window.open.$post({ param, query, json: await lecturerAddresses() }));
    },
    onSuccess: store,
  });

  const approve = useMutation({
    mutationFn: async (key: string) =>
      ok(await route.networks[":key"].approve.$post({ param: { ...param, key }, query })),
    onSuccess: store,
  });

  const decide = useMutation({
    mutationFn: async ({ rosterEntryId, decision }: { rosterEntryId: number; decision: "allow" | "keep-absent" }) =>
      ok(
        await route.held[":rosterEntryId"][decision].$post({
          param: { ...param, rosterEntryId: String(rosterEntryId) },
          query,
        }),
      ),
    onSuccess: store,
  });

  const mark = useMutation({
    mutationFn: async ({ rosterEntryId, present }: { rosterEntryId: number; present: boolean | null; undo?: Undo }) =>
      ok(
        await route.marks[":rosterEntryId"].$post({
          param: { ...param, rosterEntryId: String(rosterEntryId) },
          query,
          json: { present },
        }),
      ),
    onSuccess: (data, { undo: next }) => {
      store(data);
      setUndo(next ?? null);
    },
  });

  function tap(row: WhoRow, icon: "present" | "absent") {
    const present = markAfterTap(row.mark, icon);
    const first = row.name.split(/\s+/)[0] ?? row.name;
    const said =
      present === null ? `Cleared ${first}’s mark` : present ? `Marked ${first} present` : `Marked ${first} absent`;
    mark.mutate({ rosterEntryId: row.rosterEntryId, present, undo: { rosterEntryId: row.rosterEntryId, name: row.name, before: row.mark, said } });
  }

  const head = (
    <div className="sec-head">
      <h2>
        <span className="hl">Attendance</span>
      </h2>
    </div>
  );
  if (attendance.error) {
    return (
      <section className="sec" data-s="att">
        {head}
        <p className="error">{attendance.error.message}</p>
      </section>
    );
  }
  const a = attendance.data;
  const state = a?.window.state ?? "not-opened";
  const open = state === "open";
  const label = windowButton(state);
  const noNetwork = open && a?.window.lecturer && !a.window.lecturer.ipv4 && !a.window.lecturer.ipv6;
  const groups = a ? whoGroups(a.students) : [];
  const count = (status: WhoRow["status"]) => a?.students.filter((s) => s.status === status).length ?? 0;
  const error = toggle.error ?? approve.error ?? decide.error ?? mark.error;
  const popup = a ? heldPopup(a.held, dismissed) : null;
  const decideButtons = (h: HeldStudent) => (
    <>
      <button
        type="button"
        className="btn btn-sm"
        disabled={decide.isPending}
        onClick={() => decide.mutate({ rosterEntryId: h.rosterEntryId, decision: "allow" })}
      >
        Allow
      </button>
      <button
        type="button"
        className="btn-line btn-sm"
        disabled={decide.isPending}
        onClick={() => decide.mutate({ rosterEntryId: h.rosterEntryId, decision: "keep-absent" })}
      >
        Keep absent
      </button>
    </>
  );

  return (
    <section className="sec" data-s="att" aria-busy={!a}>
      {head}
      <div className="glance" aria-live="polite">
        <span className="big">
          <span className="hl">{a?.present ?? "–"}</span>
        </span>
        <span className="of">of {a?.total ?? "–"} present</span>
      </div>
      <div className="state">
        <span className={open ? "dot on" : "dot"} aria-hidden="true" />
        <span className="grow">
          {open ? "Check-in open" : state === "closed" ? "Check-in closed" : "Check-in not opened yet"}
          {open && <span className="muted"> · closes at midnight</span>}
        </span>
        <button
          type="button"
          className={open ? "btn-line btn-sm" : "btn btn-sm"}
          disabled={!a || toggle.isPending}
          onClick={() => toggle.mutate(open ? "close" : "open")}
        >
          {toggle.isPending ? (open ? "Closing…" : "Opening…") : label}
        </button>
      </div>

      {a?.networks.map((n) => (
        <div className="net-card" key={n.key} role="group" aria-label="Check-ins from another network">
          <p>{networkCard(n.students)}</p>
          {n.block && <p className="diag">Network {n.block}</p>}
          <button
            type="button"
            className="btn btn-sm btn-warn"
            disabled={approve.isPending}
            onClick={() => approve.mutate(n.key)}
          >
            {approve.isPending && approve.variables === n.key ? "Approving…" : "Approve network"}
          </button>
        </div>
      ))}

      {a && a.held.length > 0 && (
        <div className="held-card" role="group" aria-label="Scanned after you marked them absent">
          <p>Scanned after you marked them absent</p>
          <ul className="list">
            {a.held.map((h) => (
              <li key={h.rosterEntryId}>
                <span className="grow">
                  <span className="who-name">{h.name}</span> <span className="muted small num">{clockTime(h.at)}</span>
                </span>
                {decideButtons(h)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {popup && (
        <div className="held-pop" role="alertdialog" aria-labelledby="held-pop-title" aria-describedby="held-pop-detail">
          <p id="held-pop-title" className="held-pop-title">
            {popup.name} scanned in
          </p>
          <p id="held-pop-detail" className="small">
            You marked them absent. Allow the Check-in?
          </p>
          <div className="held-pop-actions">
            {decideButtons(popup)}
            <button
              type="button"
              className="link"
              onClick={() => dismiss(popup)}
            >
              Later
            </button>
          </div>
        </div>
      )}

      {noNetwork && (
        <p className="report has-problems" role="status">
          This laptop’s network couldn’t be read, so every Check-in waits for approval. Check the connection and
          reopen Check-in.
        </p>
      )}

      {a && a.total > 0 && (
        <div className="who">
          <button type="button" className="who-toggle" aria-expanded={whoOpen} onClick={() => setWhoOpen(!whoOpen)}>
            <span className="chev" aria-hidden="true">
              <ChevronIcon />
            </span>
            <span className="grow">Who’s here</span>
            <span className="muted small num">
              {[count("waiting") && `${count("waiting")} waiting`, count("absent") && `${count("absent")} not here yet`]
                .filter(Boolean)
                .join(" · ") || "everyone present"}
            </span>
          </button>
          {whoOpen &&
            groups.map((g) => (
              <div className="who-group" key={g.status}>
                <h3 className="who-title">
                  {g.title} <span className="muted num">{g.rows.length}</span>
                </h3>
                <ul className="list">
                  {g.rows.map((row) => (
                    <WhoLine key={row.rosterEntryId} row={row} busy={mark.isPending} onTap={(icon) => tap(row, icon)} />
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}

      {undo && (
        <div className="undo" role="status">
          <span className="grow">{undo.said}.</span>
          <button
            type="button"
            className="link"
            disabled={mark.isPending}
            onClick={() => mark.mutate({ rosterEntryId: undo.rosterEntryId, present: undoMark(undo.before) })}
          >
            Undo
          </button>
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error.message}
        </p>
      )}
    </section>
  );
}

/** One Student in "Who's here": name, what counts (time, Manual, waiting), and the ✓ / ✕ icons. */
function WhoLine({ row, busy, onTap }: { row: WhoRow; busy: boolean; onTap: (icon: "present" | "absent") => void }) {
  const note =
    row.mark === "present" ? (
      <span className="chip c-ok">Manual</span>
    ) : row.mark === "absent" ? (
      <span className="chip c-bad">Marked absent</span>
    ) : row.status === "waiting" ? (
      <span className="chip c-warn">Waiting</span>
    ) : row.status === "present" && row.at ? (
      <span className="muted small num">{clockTime(row.at)}</span>
    ) : null;
  const d = row.diagnostics;
  return (
    <li>
      <span className="grow">
        <span className="who-name">{row.name}</span>
        {d && (d.ip || d.deviceId) && (
          <span className="diag" title={d.block ? `Network ${d.block}` : undefined}>
            {[d.ip, d.deviceId && `device ${d.deviceId}`].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      {note}
      <button
        type="button"
        className={row.mark === "present" ? "ib mark on-ok" : "ib mark"}
        aria-pressed={row.mark === "present"}
        aria-label={row.mark === "present" ? `Clear ${row.name}’s present mark` : `Mark ${row.name} present`}
        title={row.mark === "present" ? "Clear mark" : "Mark present"}
        disabled={busy}
        onClick={() => onTap("present")}
      >
        <CheckIcon />
      </button>
      <button
        type="button"
        className={row.mark === "absent" ? "ib mark on-bad" : "ib mark"}
        aria-pressed={row.mark === "absent"}
        aria-label={row.mark === "absent" ? `Clear ${row.name}’s absent mark` : `Mark ${row.name} absent`}
        title={row.mark === "absent" ? "Clear mark" : "Mark absent"}
        disabled={busy}
        onClick={() => onTap("absent")}
      >
        <CrossIcon />
      </button>
    </li>
  );
}
