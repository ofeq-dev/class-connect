import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ok } from "../api";
import { lecturerAddresses, windowButton } from "../attendance";
import { useAttendance } from "./queries";

/**
 * The console's Attendance column: the big "19 of 32 present", whether Check-in is open, and the
 * one Open / Close / Reopen button. The count rises live: every Check-in sends attendance.changed
 * to the Lecturer's stream, which refetches it.
 */
export function AttendanceColumn({ courseId, sessionId }: { courseId: string; sessionId: string }) {
  const client = useQueryClient();
  const attendance = useAttendance(courseId, sessionId);
  const param = { courseId, sessionId };
  const route = api.api.lecturer.courses[":courseId"].sessions[":sessionId"].attendance.window;

  const toggle = useMutation({
    mutationFn: async (action: "open" | "close") => {
      if (action === "close") return ok(await route.close.$post({ param }));
      // The browser asks for its own public addresses: the Classroom network is wherever this laptop is.
      return ok(await route.open.$post({ param, json: await lecturerAddresses() }));
    },
    onSuccess: (data) => client.setQueryData(["attendance", Number(sessionId)], data),
  });

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
      {a && a.pending > 0 && (
        <p className="notice">
          {a.pending === 1 ? "1 Student" : `${a.pending} Students`} checked in from another network, waiting for
          approval.
        </p>
      )}
      {noNetwork && (
        <p className="report has-problems" role="status">
          This laptop’s network couldn’t be read, so every Check-in waits for approval. Check the connection and
          reopen Check-in.
        </p>
      )}
      {toggle.error && (
        <p className="error" role="alert">
          {toggle.error.message}
        </p>
      )}
    </section>
  );
}
