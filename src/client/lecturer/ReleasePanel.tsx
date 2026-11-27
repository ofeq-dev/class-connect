import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ok } from "../api";
import { formatInstant, type useAssignment } from "./queries";

type AssignmentData = NonNullable<ReturnType<typeof useAssignment>["data"]>;

const LEVEL_LABEL = { "not-yet": "Not yet", partly: "Partly", secure: "Secure" } as const;
const TWO_DAYS = 2 * 24 * 60 * 60 * 1000;

/** An instant as a datetime-local value in the browser's time zone. */
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Release with the match deadline (the reason shown while refused); after it, Match now and the
 * Help requests, offers and matches tables.
 */
export function ReleasePanel({ courseId, data }: { courseId: string; data: AssignmentData }) {
  const client = useQueryClient();
  const routes = api.api.lecturer.courses[":courseId"].assignments[":assignmentId"];
  const param = { courseId, assignmentId: String(data.id) };
  const settle = (a: AssignmentData) => {
    client.setQueryData(["assignment", data.id], a);
    void client.invalidateQueries({ queryKey: ["assignments"] });
  };
  const [deadline, setDeadline] = useState(() => localInput(new Date(Date.now() + TWO_DAYS)));

  const release = useMutation({
    mutationFn: async () =>
      ok(await routes.release.$post({ param, json: { matchDeadline: new Date(deadline).toISOString() } })),
    onSuccess: settle,
  });
  const matchNow = useMutation({
    mutationFn: async () => ok(await routes["match-now"].$post({ param })),
    onSuccess: settle,
  });

  if (!data.releasedAt) {
    return (
      <section className="sec" data-s="hw">
        <div className="sec-head">
          <h2><span className="hl">Release</span></h2>
        </div>
        <p className="muted small">
          Every Review and the class summary go to Students at once, and Help opens until the match deadline.
        </p>
        <div className="row">
          <label className="small">
            Match deadline{" "}
            <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </label>
          <button
            className="btn"
            disabled={release.isPending || !!data.releaseBlocker || !deadline}
            onClick={() => {
              if (confirm("Release every Review and the class summary to Students now?")) release.mutate();
            }}
          >
            Release
          </button>
        </div>
        {data.releaseBlocker && <p className="muted small" role="status">{data.releaseBlocker}</p>}
        {release.error && <p className="error">{release.error.message}</p>}
      </section>
    );
  }

  const { requests, offers, matches } = data.help;
  return (
    <section className="sec" data-s="hw">
      <div className="sec-head">
        <h2><span className="hl">Help</span></h2>
        <span className="muted small num">
          Released {formatInstant(data.releasedAt)} ·{" "}
          {data.matchedAt ? `matched ${formatInstant(data.matchedAt)}` : `matching ${formatInstant(data.matchDeadline!)}`}
        </span>
      </div>
      {!data.matchedAt && (
        <div className="row">
          <button className="btn" disabled={matchNow.isPending} onClick={() => matchNow.mutate()}>
            Match now
          </button>
          <span className="muted small">After matching, no more Help requests or offers are taken.</span>
        </div>
      )}
      {matchNow.error && <p className="error">{matchNow.error.message}</p>}

      <h3>Matches</h3>
      {matches.length === 0 ? (
        <p className="empty">{data.matchedAt ? "No pairs were made." : "Pairs appear here once matching runs."}</p>
      ) : (
        <table className="table">
          <thead><tr><th>Criterion</th><th>Student</th><th>Helper</th></tr></thead>
          <tbody>
            {matches.map((m) => (
              <tr key={`${m.criterionId}-${m.student.rosterEntryId}`}>
                <td dir="auto">{m.criterion}</td>
                <td>{m.student.name}</td>
                <td>{m.helper.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Help requests</h3>
      {requests.length === 0 ? (
        <p className="empty">No Help requests yet.</p>
      ) : (
        <table className="table">
          <thead><tr><th>Criterion</th><th>Student</th><th>Level</th><th>Asked</th><th>Helper</th></tr></thead>
          <tbody>
            {requests.map((r) => (
              <tr key={r.id}>
                <td dir="auto">{r.criterion}</td>
                <td>{r.student.name}</td>
                <td>{LEVEL_LABEL[r.level]}</td>
                <td className="num">{formatInstant(r.createdAt)}</td>
                <td>{r.helper?.name ?? (data.matchedAt ? <span className="chip c-warn">No Helper</span> : "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Helper offers</h3>
      {offers.length === 0 ? (
        <p className="empty">No offers yet.</p>
      ) : (
        <table className="table">
          <thead><tr><th>Criterion</th><th>Helper</th><th>Offered</th><th>Helping</th></tr></thead>
          <tbody>
            {offers.map((o) => (
              <tr key={o.id}>
                <td dir="auto">{o.criterion}</td>
                <td>{o.student.name}</td>
                <td className="num">{formatInstant(o.createdAt)}</td>
                <td>{o.matched.map((s) => s.name).join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
