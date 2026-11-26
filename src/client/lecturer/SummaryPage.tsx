import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, ok } from "../api";
import { formatDate, SUMMARY_STATE_LABEL, useCourse, useCourseLive, useSummary } from "./queries";

/**
 * The Session summary screen (lavender), minimal for now: Transcript upload, Generate, the
 * "Summarising…" and failed states, and the draft read-only. Editing is the next ticket.
 */
export function SummaryPage() {
  const { courseId = "", sessionId = "" } = useParams();
  useCourseLive(courseId);
  const course = useCourse(courseId);
  const summary = useSummary(courseId, sessionId);
  const client = useQueryClient();
  const routes = api.api.lecturer.courses[":courseId"].sessions[":sessionId"];
  const param = { courseId, sessionId };
  const session = useQuery({
    queryKey: ["session", Number(sessionId)],
    queryFn: async () => ok(await routes.$get({ param })),
  });
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["summary", Number(sessionId)] }),
      client.invalidateQueries({ queryKey: ["summaries"] }),
    ]);

  const [warning, setWarning] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const upload = useMutation({
    mutationFn: async (input: { text: string; fileName: string | undefined }) =>
      ok(await routes.summary.transcript.$post({ param, json: input })),
    onSuccess: (r) => {
      setWarning(r.warning);
      setPasted("");
      return refresh();
    },
  });
  const generate = useMutation({
    mutationFn: async () => ok(await routes.summary.generate.$post({ param })),
    onSuccess: refresh,
  });
  const retry = useMutation({
    mutationFn: async () => ok(await routes.summary.retry.$post({ param })),
    onSuccess: refresh,
  });

  async function chooseFile(file: File | undefined) {
    if (file) upload.mutate({ text: await file.text(), fileName: file.name });
  }

  const data = summary.data;
  const latest = data?.versions[0];
  const busy = data?.state === "summarising";

  return (
    <div className="page">
      <header className="top">
        <div className="top-stack">
          <Link className="crumb" to={`/lecturer/courses/${courseId}`}>← {course.data?.name ?? "Course"}</Link>
          <span className="title">
            Session summary{session.data && ` · ${formatDate(session.data.date)} ${session.data.start}`}
          </span>
        </div>
        {data && <span className="chip c-mute">{SUMMARY_STATE_LABEL[data.state]}</span>}
      </header>
      {summary.error && <p className="error">{summary.error.message}</p>}

      <div className="desk">
        <section className="sec" data-s="sum">
          <div className="sec-head"><h2><span className="hl">Transcript</span></h2></div>
          <p className="notice">A Zoom <code>.vtt</code> or a <code>.txt</code> file, or paste the text. A new upload replaces the old one.</p>
          <input
            type="file"
            accept=".vtt,.txt,text/vtt,text/plain"
            aria-label="Transcript file"
            disabled={upload.isPending}
            onChange={(e) => {
              void chooseFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <label className="field">
            <span>Or paste it</span>
            <textarea dir="auto" rows={4} value={pasted} onChange={(e) => setPasted(e.target.value)} />
          </label>
          <div className="row">
            <button
              className="btn-line"
              disabled={!pasted.trim() || upload.isPending}
              onClick={() => upload.mutate({ text: pasted, fileName: undefined })}
            >
              Use pasted text
            </button>
          </div>
          {upload.error && <p className="error">{upload.error.message}</p>}
          {warning && <p className="report has-problems" role="status">{warning}</p>}
          {data?.transcript && (
            <details>
              <summary className="muted small">
                {data.transcript.fileName ?? "Pasted text"} · {data.transcript.text.split("\n").length} lines
                {!data.transcript.hasTimestamps && " · no timestamps"}
              </summary>
              <pre className="transcript" dir="auto">{data.transcript.text}</pre>
            </details>
          )}
        </section>

        <section className="sec" data-s="sum">
          <div className="sec-head">
            <h2><span className="hl">Draft</span></h2>
            {data?.transcript && !busy && (
              <button
                className="btn"
                disabled={generate.isPending}
                onClick={() => {
                  if (!latest || confirm("Generate a new draft? It's added as a new version; nothing is lost.")) {
                    generate.mutate();
                  }
                }}
              >
                {latest ? "Regenerate" : "Generate"}
              </button>
            )}
          </div>
          {data && !data.transcript && <p className="empty">Upload a Transcript to generate a summary.</p>}
          {busy && <p role="status"><b>Summarising…</b> <span className="muted">This can take a few minutes.</span></p>}
          {data?.state === "failed" && (
            <div className="report has-problems" role="alert">
              <b>The summary couldn't be made.</b>
              <span>{data.error}</span>
              <div className="row">
                <button className="btn-line" disabled={retry.isPending} onClick={() => retry.mutate()}>Retry</button>
              </div>
            </div>
          )}
          {generate.error && <p className="error">{generate.error.message}</p>}
          {retry.error && <p className="error">{retry.error.message}</p>}
          {latest && (
            <>
              <p className="muted small">
                Version {latest.number} · {latest.author === "ai" ? "AI" : "Lecturer"} ·{" "}
                {new Date(latest.createdAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
              </p>
              <pre className="transcript" dir="auto">{latest.markdown}</pre>
            </>
          )}
          {data && data.versions.length > 1 && (
            <ul className="list" aria-label="Versions">
              {data.versions.map((v) => (
                <li key={v.id}>
                  <span className="grow num">Version {v.number}</span>
                  <span className="muted small">{v.author === "ai" ? "AI" : "Lecturer"}</span>
                  <span className="muted small num">
                    {new Date(v.createdAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
