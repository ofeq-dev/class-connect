import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api, ok } from "../api";
import { SummaryView } from "../markdown/SummaryView";
import { formatDate, SUMMARY_STATE_LABEL, useCourse, useCourseLive, useSummary } from "./queries";

/**
 * The Session summary screen (lavender), minimal: Transcript upload, Generate, the
 * "Summarising…" and failed states, the Markdown editor with a live preview, Save, and the
 * version list with Restore and Publish, and the published version's translations with a
 * language switcher, per-language status and an editor without history.
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

  // The editor holds the newest version until the Lecturer types; null means "not edited".
  const [edited, setEdited] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (markdown: string) => ok(await routes.summary.versions.$post({ param, json: { markdown } })),
    onSuccess: () => {
      setEdited(null);
      return refresh();
    },
  });
  const versionRoutes = routes.summary.versions[":versionId"];
  const restore = useMutation({
    mutationFn: async (versionId: number) =>
      ok(await versionRoutes.restore.$post({ param: { ...param, versionId: String(versionId) } })),
    onSuccess: () => {
      setEdited(null);
      return refresh();
    },
  });
  const publish = useMutation({
    mutationFn: async (versionId: number) =>
      ok(await versionRoutes.publish.$post({ param: { ...param, versionId: String(versionId) } })),
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
          {(latest || data?.transcript) && !busy && (
            <Editor
              markdown={edited ?? latest?.markdown ?? ""}
              onChange={setEdited}
              saving={save.isPending}
              dirty={edited !== null && edited !== (latest?.markdown ?? "")}
              onSave={() => edited !== null && save.mutate(edited)}
              onDiscard={() => setEdited(null)}
            />
          )}
          {save.error && <p className="error">{save.error.message}</p>}
        </section>

        {data && data.versions.length > 0 && (
          <section className="sec" data-s="sum">
            <div className="sec-head"><h2><span className="hl">Versions</span></h2></div>
            <p className="notice">
              {data.publishedVersionId
                ? "Students see the published version only, until you publish another."
                : "Students see nothing until you publish a version."}
            </p>
            <ul className="list" aria-label="Versions">
              {data.versions.map((v) => {
                const isPublished = v.id === data.publishedVersionId;
                return (
                  <li key={v.id}>
                    <span className="grow num">
                      Version {v.number}
                      {isPublished && <> <span className="chip c-mute">Published</span></>}
                    </span>
                    <span className="muted small">{v.author === "ai" ? "AI" : "Lecturer"}</span>
                    <span className="muted small num">
                      {new Date(v.createdAt).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}
                    </span>
                    {v.id !== latest?.id && (
                      <button
                        className="btn-line"
                        disabled={restore.isPending}
                        onClick={() => {
                          if (edited === null || confirm("Discard your unsaved edit and restore this version?")) {
                            restore.mutate(v.id);
                          }
                        }}
                      >
                        Restore
                      </button>
                    )}
                    {!isPublished && (
                      <button
                        className="btn"
                        disabled={publish.isPending}
                        onClick={() => {
                          const message = data.translations.length
                            ? `Publish version ${v.number}? Students will see it on their phones, and every translation is made again from it. Edits to the translations will be overwritten.`
                            : `Publish version ${v.number}? Students will see it on their phones.`;
                          if (confirm(message)) {
                            publish.mutate(v.id);
                          }
                        }}
                      >
                        Publish this version
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {restore.error && <p className="error">{restore.error.message}</p>}
            {publish.error && <p className="error">{publish.error.message}</p>}
          </section>
        )}

        {data && data.translations.length > 0 && (
          <Translations courseId={courseId} sessionId={sessionId} translations={data.translations} onChange={refresh} />
        )}
      </div>
    </div>
  );
}

/** The Markdown source beside its live preview, rendered as Students will see it. */
function Editor(props: {
  markdown: string;
  onChange: (markdown: string) => void;
  saving: boolean;
  dirty: boolean;
  onSave: () => void;
  onDiscard: () => void;
  note?: string;
}) {
  return (
    <>
      <div className="editor">
        <label className="field">
          <span>Markdown</span>
          <textarea
            dir="auto"
            rows={20}
            value={props.markdown}
            onChange={(e) => props.onChange(e.target.value)}
          />
        </label>
        <div className="field">
          <span>Preview</span>
          <SummaryView markdown={props.markdown} className="preview" />
        </div>
      </div>
      <div className="row">
        <button className="btn" disabled={!props.dirty || props.saving} onClick={props.onSave}>
          Save
        </button>
        {props.dirty && (
          <button className="btn-line" onClick={props.onDiscard}>
            Discard edit
          </button>
        )}
        <span className="muted small">{props.note ?? "Saving adds a new version; nothing is lost."}</span>
      </div>
    </>
  );
}

const TRANSLATION_STATE_LABEL = { translating: "Translating…", failed: "Failed", done: "Ready" } as const;

type Translation = {
  language: string;
  state: keyof typeof TRANSLATION_STATE_LABEL;
  markdown: string | null;
  error: string | null;
  edited: boolean;
};

/** The published version's translations: a language switcher with each one's status, and its editor. */
function Translations(props: {
  courseId: string;
  sessionId: string;
  translations: Translation[];
  onChange: () => Promise<unknown>;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const current = props.translations.find((x) => x.language === chosen) ?? props.translations[0]!;
  const [edited, setEdited] = useState<string | null>(null);
  const routes = api.api.lecturer.courses[":courseId"].sessions[":sessionId"].summary.translations[":language"];
  const param = { courseId: props.courseId, sessionId: props.sessionId, language: current.language };
  const save = useMutation({
    mutationFn: async (markdown: string) => ok(await routes.$put({ param, json: { markdown } })),
    onSuccess: () => {
      setEdited(null);
      return props.onChange();
    },
  });
  const retry = useMutation({
    mutationFn: async () => ok(await routes.retry.$post({ param })),
    onSuccess: props.onChange,
  });

  function choose(language: string) {
    if (edited === null || confirm("Discard your unsaved edit to this translation?")) {
      setEdited(null);
      setChosen(language);
    }
  }

  return (
    <section className="sec" data-s="sum">
      <div className="sec-head"><h2><span className="hl">Translations</span></h2></div>
      <p className="notice">Made from the published version. Publishing again makes them afresh.</p>
      <div className="row" role="tablist" aria-label="Translation language">
        {props.translations.map((x) => (
          <button
            key={x.language}
            role="tab"
            aria-selected={x.language === current.language}
            className={x.language === current.language ? "btn" : "btn-line"}
            onClick={() => choose(x.language)}
          >
            {x.language} · {TRANSLATION_STATE_LABEL[x.state]}
            {x.edited && " · edited"}
          </button>
        ))}
      </div>
      {current.state === "translating" && <p role="status"><b>Translating…</b></p>}
      {current.state === "failed" && (
        <div className="report has-problems" role="alert">
          <b>This translation couldn't be made.</b>
          <span>{current.error}</span>
          <div className="row">
            <button className="btn-line" disabled={retry.isPending} onClick={() => retry.mutate()}>Retry</button>
          </div>
        </div>
      )}
      {current.markdown !== null && (
        <Editor
          key={current.language}
          markdown={edited ?? current.markdown}
          onChange={setEdited}
          saving={save.isPending}
          dirty={edited !== null && edited !== current.markdown}
          onSave={() => edited !== null && save.mutate(edited)}
          onDiscard={() => setEdited(null)}
          note="Saving replaces this translation; there is no history."
        />
      )}
      {save.error && <p className="error">{save.error.message}</p>}
      {retry.error && <p className="error">{retry.error.message}</p>}
    </section>
  );
}
