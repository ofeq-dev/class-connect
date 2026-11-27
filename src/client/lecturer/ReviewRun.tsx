import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { api, ok } from "../api";
import { formatInstant, type useAssignment } from "./queries";

type AssignmentData = NonNullable<ReturnType<typeof useAssignment>["data"]>;
type SubmissionData = AssignmentData["submissions"][number];
type LevelData = SubmissionData["review"]["levels"][number];
type Level = LevelData["level"];

const LEVEL_LABEL: Record<Level, string> = { "not-yet": "Not yet", partly: "Partly", secure: "Secure" };
const STATUS_LABEL: Record<SubmissionData["review"]["status"], string> = {
  "not-started": "Not reviewed",
  queued: "Waiting",
  running: "Reviewing…",
  failed: "Failed",
  drafted: "Draft",
};
const percent = (x: number) => `${Math.round(x * 100)}%`;

function useRoutes(courseId: string, assignmentId: number) {
  const client = useQueryClient();
  const routes = api.api.lecturer.courses[":courseId"].assignments[":assignmentId"];
  const param = { courseId, assignmentId: String(assignmentId) };
  const settle = (a: AssignmentData) => {
    client.setQueryData(["assignment", assignmentId], a);
    void client.invalidateQueries({ queryKey: ["assignments"] });
    void client.invalidateQueries({ queryKey: ["llm-usage"] });
  };
  return { routes, param, settle };
}

/**
 * The Assignment screen after the due date (minimal): Start review run with its `n of m`
 * progress, the Submissions with their Review status, Retry on a failed draft, a Review editor
 * per Submission ("Write by hand" for a failed one), the Similar pairs panel and the class
 * summary preview.
 */
export function ReviewRun({ courseId, data }: { courseId: string; data: AssignmentData }) {
  const { routes, param, settle } = useRoutes(courseId, data.id);
  const [open, setOpen] = useState<number | null>(null);

  const start = useMutation({
    mutationFn: async () => ok(await routes["review-run"].$post({ param })),
    onSuccess: settle,
  });
  const retry = useMutation({
    mutationFn: async (submissionId: number) =>
      ok(
        await routes.submissions[":submissionId"].review.retry.$post({
          param: { ...param, submissionId: String(submissionId) },
        }),
      ),
    onSuccess: settle,
  });

  const run = data.reviewRun;
  const reviewing = data.state === "reviewing";
  const unreviewed = data.submissions.filter((s) => s.review.status === "not-started").length;

  return (
    <>
      <section className="sec" data-s="hw">
        <div className="sec-head">
          <h2><span className="hl">Submissions</span></h2>
          <span className="muted small num">{data.submissions.length} handed in</span>
        </div>
        {data.state !== "open" && (
          <div className="row">
            <button
              className="btn"
              disabled={start.isPending || reviewing || unreviewed === 0}
              title={unreviewed === 0 ? "Every Submission has a Review" : undefined}
              onClick={() => start.mutate()}
            >
              {run ? `Review ${unreviewed} more` : "Start review run"}
            </button>
            {run && (
              <span className="grow row">
                <progress max={run.total} value={run.done} aria-label="Review run progress" />
                <span className="small num" role="status">
                  {run.done} of {run.total}
                  {run.failed > 0 && <span className="chip c-warn">{run.failed} failed</span>}
                  {run.compare && run.compare !== "done" && <span className="muted"> · comparing</span>}
                  {run.classSummary && run.classSummary !== "done" && <span className="muted"> · class summary</span>}
                </span>
              </span>
            )}
          </div>
        )}
        {run?.error && <p className="error">{run.error}</p>}
        {start.error && <p className="error">{start.error.message}</p>}
        {retry.error && <p className="error">{retry.error.message}</p>}

        {data.submissions.length === 0 ? (
          <p className="empty">Nothing handed in yet. Students hand in from the Assignment on their phone’s Today tab.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Student</th><th>Handed in</th><th>Late</th><th>Review</th><th /></tr>
            </thead>
            <tbody>
              {data.submissions.map((s) => {
                const r = s.review;
                const busy = r.status === "queued" || r.status === "running";
                return (
                  <Fragment key={s.id}>
                    <tr>
                      <td>
                        {s.studentName} <span className="muted small num">{s.studentId}</span>
                        {s.fileName && <span className="muted small"> · {s.fileName}</span>}
                      </td>
                      <td className="num">{formatInstant(s.submittedAt)}</td>
                      <td>{s.late && <span className="chip c-warn">Late</span>}</td>
                      <td>
                        <span className={`chip ${r.status === "failed" ? "c-warn" : r.status === "drafted" ? "c-ok" : "c-mute"}`}>
                          {STATUS_LABEL[r.status]}
                        </span>
                        {r.status === "drafted" && r.author === "lecturer" && <span className="muted small"> by hand</span>}
                        {r.status === "drafted" && r.editedAt && r.author === "ai" && <span className="muted small"> edited</span>}
                        {r.error && <div className="error small">{r.error}</div>}
                      </td>
                      <td>
                        <span className="row">
                          {r.status === "failed" && (
                            <button className="btn-line" disabled={retry.isPending} onClick={() => retry.mutate(s.id)}>
                              Retry
                            </button>
                          )}
                          {!busy && data.state !== "open" && (
                            <button className="link" onClick={() => setOpen(open === s.id ? null : s.id)}>
                              {open === s.id ? "Close" : r.status === "drafted" ? "Edit" : "Write by hand"}
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                    {open === s.id && (
                      <tr>
                        <td colSpan={5}>
                          <ReviewEditor courseId={courseId} data={data} submission={s} onSaved={() => setOpen(null)} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {run && <SimilarPairs data={data} />}
      {data.classSummary && <ClassSummaryPreview summary={data.classSummary} />}
    </>
  );
}

function ReviewEditor(props: {
  courseId: string;
  data: AssignmentData;
  submission: SubmissionData;
  onSaved: () => void;
}) {
  const { data, submission } = props;
  const { routes, param, settle } = useRoutes(props.courseId, data.id);
  const [levels, setLevels] = useState<LevelData[]>(() =>
    data.criteria.map(
      (c) =>
        submission.review.levels.find((l) => l.criterionId === c.id) ?? {
          criterionId: c.id,
          level: "partly",
          evidence: "",
          feedback: "",
        },
    ),
  );
  const save = useMutation({
    mutationFn: async () =>
      ok(
        await routes.submissions[":submissionId"].review.$put({
          param: { ...param, submissionId: String(submission.id) },
          json: { levels },
        }),
      ),
    onSuccess: (a) => {
      settle(a);
      props.onSaved();
    },
  });
  const set = (i: number, changes: Partial<LevelData>) =>
    setLevels((ls) => ls.map((l, j) => (j === i ? { ...l, ...changes } : l)));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <details open={submission.review.status !== "drafted"}>
        <summary className="muted small">The Submission</summary>
        <p className="transcript" dir="auto">{submission.text}</p>
      </details>
      {data.criteria.map((c, i) => (
        <fieldset key={c.id} className="field">
          <legend><b>{c.label}</b></legend>
          <label className="field">
            <span>Level</span>
            <select value={levels[i]!.level} onChange={(e) => set(i, { level: e.target.value as Level })}>
              {(Object.keys(LEVEL_LABEL) as Level[]).map((l) => (
                <option key={l} value={l}>{LEVEL_LABEL[l]}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Evidence</span>
            <input type="text" dir="auto" value={levels[i]!.evidence} onChange={(e) => set(i, { evidence: e.target.value })} />
          </label>
          <label className="field">
            <span>Feedback</span>
            <textarea dir="auto" rows={2} required value={levels[i]!.feedback} onChange={(e) => set(i, { feedback: e.target.value })} />
          </label>
        </fieldset>
      ))}
      <div className="row">
        <button className="btn" type="submit" disabled={save.isPending}>Save Review</button>
      </div>
      {save.error && <p className="error">{save.error.message}</p>}
    </form>
  );
}

function SimilarPairs({ data }: { data: AssignmentData }) {
  return (
    <section className="sec" data-s="hw">
      <div className="sec-head">
        <h2><span className="hl">Similar pairs</span></h2>
        <span className="muted small">Only you see these. They change no level.</span>
      </div>
      {data.similarPairs.length === 0 ? (
        <p className="empty">{data.reviewRun?.compare === "done" ? "No similar pairs." : "Compared once the drafts are done."}</p>
      ) : (
        data.similarPairs.map((p) => (
          <div key={`${p.a.submissionId}-${p.b.submissionId}`} className="card">
            <div className="row">
              <b className="grow">{p.a.studentName} · {p.b.studentName}</b>
              <span className="chip c-warn num">{percent(p.score)}</span>
            </div>
            <p className="muted small num">
              Fingerprints {percent(p.fingerprintOverlap)} · Meaning{" "}
              {p.embeddingSimilarity === null ? "unavailable" : percent(p.embeddingSimilarity)}
            </p>
            <table className="table">
              <thead>
                <tr><th>{p.a.studentName}</th><th>{p.b.studentName}</th></tr>
              </thead>
              <tbody>
                {p.passages.map((passage, i) => (
                  <tr key={i}>
                    <td dir="auto">{passage.a}</td>
                    <td dir="auto">{passage.b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </section>
  );
}

function ClassSummaryPreview({ summary }: { summary: NonNullable<AssignmentData["classSummary"]> }) {
  return (
    <section className="sec" data-s="hw">
      <div className="sec-head">
        <h2><span className="hl">Class summary</span></h2>
        <span className="muted small num">from {summary.reviewCount} Reviews · preview</span>
      </div>
      <table className="table">
        <thead>
          <tr><th>Criterion</th><th>Not yet</th><th>Partly</th><th>Secure</th></tr>
        </thead>
        <tbody>
          {summary.counts.map((c) => (
            <tr key={c.criterionId}>
              <td dir="auto">{c.label}</td>
              <td className="num">{c.notYet}</td>
              <td className="num">{c.partly}</td>
              <td className="num">{c.secure}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {summary.commonMistakes.length > 0 && (
        <>
          <h3>Common mistakes</h3>
          <ul>
            {summary.commonMistakes.map((m, i) => (
              <li key={i} dir="auto">{m}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
