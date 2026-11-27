import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api, ok } from "../api";
import { EditIcon, TrashIcon } from "./icons";
import { DiagnosticsItem } from "./DiagnosticsItem";
import { Menu } from "./Menu";
import {
  ASSIGNMENT_STATE_LABEL,
  formatDate,
  formatInstant,
  projectorUrl,
  SUMMARY_STATE_LABEL,
  useAssignments,
  useCourse,
  useCourseLive,
  useLlmUsage,
  useProjector,
  useRoster,
  useSessions,
  useSummaries,
} from "./queries";

interface Session {
  id: number;
  date: string;
  start: string;
  end: string;
}

export function CourseDesk() {
  const { courseId = "" } = useParams();
  useCourseLive(courseId);
  const course = useCourse(courseId);
  const roster = useRoster(courseId);
  const usage = useLlmUsage();

  if (course.error) return <p className="page error">{course.error.message}</p>;
  const claimed = roster.data?.filter((e) => e.claimed).length ?? 0;

  return (
    <div className="page">
      <header className="top">
        <div className="top-stack">
          <Link className="crumb" to="/lecturer">← Your Courses</Link>
          <span className="title">{course.data?.name ?? " "}</span>
        </div>
        {usage.data && (
          <span className="muted small num">
            LLM requests today: {usage.data.today} / {usage.data.limit}
          </span>
        )}
        <Menu label="Course menu">
          <Link to={`/lecturer/courses/${courseId}/roster`}>Roster</Link>
          <Link to={`/lecturer/courses/${courseId}/settings`}>Course settings</Link>
          <DiagnosticsItem />
        </Menu>
      </header>

      <div className="desk">
        <SessionsSection courseId={courseId} />
        <SummariesSection courseId={courseId} />
        <AssignmentsSection courseId={courseId} />
        <ProjectorSection courseId={courseId} />
        <section className="sec" data-s="ros">
          <div className="sec-head">
            <h2><span className="hl">Roster</span></h2>
            <Link className="btn-line" to={`/lecturer/courses/${courseId}/roster`}>Open</Link>
          </div>
          {roster.data &&
            (roster.data.length === 0 ? (
              <p className="empty">No Students yet. Import the Roster CSV to list everyone enrolled.</p>
            ) : (
              <p>
                <b className="num">{roster.data.length}</b> Students, <b className="num">{claimed}</b> with a
                claimed phone.
              </p>
            ))}
        </section>
      </div>
    </div>
  );
}

function SessionsSection({ courseId }: { courseId: string }) {
  const sessions = useSessions(courseId);
  const [adding, setAdding] = useState(false);
  const [showPast, setShowPast] = useState(false);
  const data = sessions.data;
  const today = data?.today ?? "";
  const todays = data?.sessions.filter((s) => s.date === today) ?? [];
  const upcoming = data?.sessions.filter((s) => s.date > today) ?? [];
  const past = (data?.sessions.filter((s) => s.date < today) ?? []).reverse();

  return (
    <section className="sec" data-s="att">
      <div className="sec-head">
        <h2><span className="hl">Sessions</span></h2>
        {!adding && <button className="btn-line" onClick={() => setAdding(true)}>+ Session</button>}
      </div>
      {adding && <SessionForm courseId={courseId} initial={{ date: today, start: "", end: "" }} onDone={() => setAdding(false)} />}

      {todays.map((s) => (
        <div className="today" key={s.id}>
          <span className="muted small">Today</span>
          <span className="when num">{s.start}–{s.end}</span>
          <div className="row">
            <Link className="btn" to={`/lecturer/courses/${courseId}/sessions/${s.id}/live`}>Open live console</Link>
          </div>
        </div>
      ))}

      {data && data.sessions.length === 0 && !adding && (
        <p className="empty">No Sessions yet. Add one for each meeting of the Course.</p>
      )}

      {upcoming.length > 0 && (
        <ul className="list" aria-label="Upcoming Sessions">
          {upcoming.map((s) => <SessionRow key={s.id} courseId={courseId} session={s} />)}
        </ul>
      )}

      {past.length > 0 && (
        <>
          <button className="more" onClick={() => setShowPast(!showPast)}>
            {showPast ? "▾" : "▸"} Past Sessions ({past.length})
          </button>
          {showPast && (
            <ul className="list" aria-label="Past Sessions">
              {past.map((s) => <SessionRow key={s.id} courseId={courseId} session={s} />)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function SummariesSection({ courseId }: { courseId: string }) {
  const sessions = useSessions(courseId);
  const summaries = useSummaries(courseId);
  const client = useQueryClient();
  const retry = useMutation({
    mutationFn: async (sessionId: number) =>
      ok(
        await api.api.lecturer.courses[":courseId"].sessions[":sessionId"].summary.retry.$post({
          param: { courseId, sessionId: String(sessionId) },
        }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["summaries"] }),
  });
  const byId = new Map(sessions.data?.sessions.map((s) => [s.id, s]));
  const rows = [...(summaries.data ?? [])].reverse(); // newest Session first

  return (
    <section className="sec" data-s="sum">
      <div className="sec-head">
        <h2><span className="hl">Session summaries</span></h2>
      </div>
      {summaries.data && rows.length === 0 && <p className="empty">Add a Session to summarise it.</p>}
      <ul className="list" aria-label="Session summaries">
        {rows.map((row) => {
          const s = byId.get(row.sessionId);
          if (!s) return null;
          return (
            <li key={row.sessionId}>
              <Link className="grow" to={`/lecturer/courses/${courseId}/sessions/${row.sessionId}/summary`}>
                <b>{formatDate(s.date)}</b> <span className="muted num">{s.start}</span>
              </Link>
              <span className={`chip ${row.state === "failed" ? "c-warn" : row.state === "draft" ? "c-ok" : "c-mute"}`}>
                {SUMMARY_STATE_LABEL[row.state]}
              </span>
              {row.state === "failed" && (
                <button className="btn-line" disabled={retry.isPending} onClick={() => retry.mutate(row.sessionId)}>
                  Retry
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {retry.error && <p className="error">{retry.error.message}</p>}
    </section>
  );
}

function AssignmentsSection({ courseId }: { courseId: string }) {
  const assignments = useAssignments(courseId);
  return (
    <section className="sec" data-s="hw">
      <div className="sec-head">
        <h2><span className="hl">Assignments</span></h2>
        <Link className="btn-line" to={`/lecturer/courses/${courseId}/assignments/new`}>+ Assignment</Link>
      </div>
      {assignments.data?.length === 0 && (
        <p className="empty">No Assignments yet. Set one with 3–5 Criteria and Students hand in from their phones.</p>
      )}
      <ul className="list" aria-label="Assignments">
        {assignments.data?.map((a) => (
          <li key={a.id}>
            <Link className="grow" to={`/lecturer/courses/${courseId}/assignments/${a.id}`}>
              <b>{a.title}</b> <span className="muted num">due {formatInstant(a.dueAt)}</span>
            </Link>
            <span className="muted small num">
              {a.state === "reviewing" && a.reviewRun
                ? `review run ${a.reviewRun.done} of ${a.reviewRun.total}`
                : `${a.submissionCount} handed in`}
            </span>
            <span className={`chip ${a.state === "open" ? "c-ok" : "c-mute"}`}>{ASSIGNMENT_STATE_LABEL[a.state]}</span>
          </li>
        ))}
      </ul>
      {assignments.error && <p className="error">{assignments.error.message}</p>}
    </section>
  );
}

function SessionRow({ courseId, session }: { courseId: string; session: Session }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const remove = useMutation({
    mutationFn: async () =>
      ok(
        await api.api.lecturer.courses[":courseId"].sessions[":sessionId"].$delete({
          param: { courseId, sessionId: String(session.id) },
        }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["sessions"] }),
  });

  if (editing) {
    return (
      <li>
        <SessionForm courseId={courseId} sessionId={session.id} initial={session} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li>
      <span className="grow">
        <b>{formatDate(session.date)}</b> <span className="muted num">{session.start}–{session.end}</span>
      </span>
      <button className="ib" aria-label="Edit Session" title="Edit" onClick={() => setEditing(true)}>
        <EditIcon />
      </button>
      <button
        className="ib bad"
        aria-label="Delete Session"
        title="Delete"
        onClick={() => {
          if (confirm(`Delete the Session on ${formatDate(session.date)} at ${session.start}?`)) remove.mutate();
        }}
      >
        <TrashIcon />
      </button>
    </li>
  );
}

function SessionForm(props: {
  courseId: string;
  sessionId?: number;
  initial: { date: string; start: string; end: string };
  onDone: () => void;
}) {
  const client = useQueryClient();
  const [form, setForm] = useState(props.initial);
  const save = useMutation({
    mutationFn: async () => {
      const courses = api.api.lecturer.courses[":courseId"];
      return props.sessionId
        ? ok(await courses.sessions[":sessionId"].$patch({
            param: { courseId: props.courseId, sessionId: String(props.sessionId) },
            json: form,
          }))
        : ok(await courses.sessions.$post({ param: { courseId: props.courseId }, json: form }));
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["sessions"] });
      props.onDone();
    },
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <form className="form-row" onSubmit={submit}>
      <label className="field"><span>Date</span><input type="date" required value={form.date} onChange={set("date")} /></label>
      <label className="field"><span>Starts</span><input type="time" required value={form.start} onChange={set("start")} /></label>
      <label className="field"><span>Ends</span><input type="time" required value={form.end} onChange={set("end")} /></label>
      <button className="btn" type="submit" disabled={save.isPending}>{props.sessionId ? "Save" : "Add"}</button>
      <button className="link" type="button" onClick={props.onDone}>Cancel</button>
      {save.error && <p className="error">{save.error.message}</p>}
    </form>
  );
}

/**
 * The Course's Projector window link: open it on the laptop's second display or set it up once on a
 * classroom PC. "New link" replaces it, and the old one stops working (say, after it was shared).
 */
function ProjectorSection({ courseId }: { courseId: string }) {
  const client = useQueryClient();
  const projector = useProjector(courseId);
  const [copied, setCopied] = useState(false);
  const renew = useMutation({
    mutationFn: async () =>
      ok(await api.api.lecturer.courses[":courseId"].projector["new-link"].$post({ param: { courseId } })),
    onSuccess: (data) => {
      client.setQueryData(["projector", "course", Number(courseId)], data);
      setCopied(false);
    },
  });
  const url = projector.data ? projectorUrl(projector.data.secret) : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="sec" data-s="att">
      <div className="sec-head">
        <h2><span className="hl">Projector window</span></h2>
      </div>
      <p className="notice">
        Shows the QR code and live count to the room, with no sign-in. Open it on the projector display or keep it on a
        classroom PC.
      </p>
      {projector.error && <p className="error">{projector.error.message}</p>}
      {projector.data && (
        <>
          <input className="linkbox" type="text" readOnly value={url} aria-label="Projector link" onFocus={(e) => e.target.select()} />
          <div className="row">
            <button type="button" className="btn-line btn-sm" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy link"}
            </button>
            <a className="btn-line btn-sm" href={url} target="cc-projector" rel="noopener">
              Open
            </a>
            <button
              type="button"
              className="btn-line btn-sm"
              disabled={renew.isPending}
              onClick={() => {
                if (confirm("Make a new projector link? The old one stops working at once, including on a classroom PC.")) {
                  renew.mutate();
                }
              }}
            >
              {renew.isPending ? "Making…" : "New link"}
            </button>
          </div>
        </>
      )}
      {renew.error && <p className="error" role="alert">{renew.error.message}</p>}
    </section>
  );
}
