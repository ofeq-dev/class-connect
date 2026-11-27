import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ok } from "../api";
import { TrashIcon } from "./icons";
import { ASSIGNMENT_STATE_LABEL, formatInstant, useAssignment, useCourse, useCourseLive } from "./queries";

const MIN = 3;
const MAX = 5;

interface Form {
  title: string;
  instructions: string;
  /** A datetime-local value, in the browser's time zone. */
  due: string;
  criteria: string[];
}

/** An instant as a datetime-local value in the browser's time zone. */
function localInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * The Assignment screen (apricot), minimal: title, instructions, due date and the Criteria
 * editor with "Draft with AI"; then the Submissions table. The review run comes later.
 */
export function AssignmentPage() {
  const { courseId = "", assignmentId } = useParams();
  useCourseLive(courseId);
  const course = useCourse(courseId);
  const assignment = useAssignment(courseId, assignmentId);
  const data = assignment.data;

  return (
    <div className="page">
      <header className="top">
        <div className="top-stack">
          <Link className="crumb" to={`/lecturer/courses/${courseId}`}>← {course.data?.name ?? "Course"}</Link>
          <span className="title">{assignmentId ? (data?.title ?? " ") : "New Assignment"}</span>
        </div>
        {data && <span className="chip c-mute">{ASSIGNMENT_STATE_LABEL[data.state]}</span>}
      </header>
      {assignment.error && <p className="error">{assignment.error.message}</p>}

      <div className="desk">
        {(!assignmentId || data) && (
          <AssignmentForm
            key={data?.id ?? "new"}
            courseId={courseId}
            assignmentId={data?.id}
            initial={
              data
                ? {
                    title: data.title,
                    instructions: data.instructions,
                    due: localInput(data.dueAt),
                    criteria: data.criteria.map((c) => c.label),
                  }
                : { title: "", instructions: "", due: "", criteria: ["", "", ""] }
            }
          />
        )}

        {data && (
          <section className="sec" data-s="hw">
            <div className="sec-head">
              <h2><span className="hl">Submissions</span></h2>
              <span className="muted small num">{data.submissions.length} handed in</span>
            </div>
            {data.submissions.length === 0 ? (
              <p className="empty">Nothing handed in yet. Students hand in from the Assignment on their phone’s Today tab.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Student</th><th>Handed in</th><th>Late</th></tr>
                </thead>
                <tbody>
                  {data.submissions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        {s.studentName} <span className="muted small num">{s.studentId}</span>
                        {s.fileName && <span className="muted small"> · {s.fileName}</span>}
                      </td>
                      <td className="num">{formatInstant(s.submittedAt)}</td>
                      <td>{s.late && <span className="chip c-warn">Late</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function AssignmentForm(props: { courseId: string; assignmentId?: number; initial: Form }) {
  const { courseId, assignmentId } = props;
  const client = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState(props.initial);
  const [saved, setSaved] = useState(false);
  const routes = api.api.lecturer.courses[":courseId"].assignments;

  const save = useMutation({
    mutationFn: async () => {
      const json = {
        title: form.title,
        instructions: form.instructions,
        dueAt: form.due ? new Date(form.due).toISOString() : "",
        criteria: form.criteria,
      };
      return assignmentId
        ? ok(await routes[":assignmentId"].$put({ param: { courseId, assignmentId: String(assignmentId) }, json }))
        : ok(await routes.$post({ param: { courseId }, json }));
    },
    onSuccess: async (a) => {
      await client.invalidateQueries({ queryKey: ["assignments"] });
      await client.invalidateQueries({ queryKey: ["assignment", a.id] });
      setSaved(true);
      if (!assignmentId) void navigate(`/lecturer/courses/${courseId}/assignments/${a.id}`, { replace: true });
    },
  });

  const draft = useMutation({
    mutationFn: async () =>
      ok(
        await routes["draft-criteria"].$post({
          param: { courseId },
          json: { title: form.title, instructions: form.instructions },
        }),
      ),
    onSuccess: ({ criteria }) => {
      setForm((f) => ({ ...f, criteria }));
      setSaved(false);
      return client.invalidateQueries({ queryKey: ["llm-usage"] });
    },
  });

  const edit = (changes: Partial<Form>) => {
    setForm((f) => ({ ...f, ...changes }));
    setSaved(false);
  };
  const setCriterion = (i: number, label: string) => edit({ criteria: form.criteria.map((c, j) => (j === i ? label : c)) });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <form className="sec" data-s="hw" onSubmit={submit}>
      <div className="sec-head"><h2><span className="hl">Assignment</span></h2></div>
      <label className="field">
        <span>Title</span>
        <input type="text" required dir="auto" value={form.title} onChange={(e) => edit({ title: e.target.value })} />
      </label>
      <label className="field">
        <span>Instructions</span>
        <textarea dir="auto" rows={6} value={form.instructions} onChange={(e) => edit({ instructions: e.target.value })} />
      </label>
      <label className="field">
        <span>Due</span>
        <input type="datetime-local" required value={form.due} onChange={(e) => edit({ due: e.target.value })} />
      </label>

      <div className="sec-head">
        <h3>Criteria <span className="muted small">({MIN}–{MAX})</span></h3>
        <button
          type="button"
          className="btn-line"
          disabled={draft.isPending || !form.instructions.trim()}
          title={form.instructions.trim() ? undefined : "Write the instructions first"}
          onClick={() => {
            if (!form.criteria.some((c) => c.trim()) || confirm("Replace these Criteria with a fresh draft?")) {
              draft.mutate();
            }
          }}
        >
          {draft.isPending ? "Drafting…" : "Draft with AI"}
        </button>
      </div>
      <ol className="list" aria-label="Criteria">
        {form.criteria.map((c, i) => (
          <li key={i}>
            <span className="muted num">{i + 1}.</span>
            <input
              type="text"
              className="grow"
              dir="auto"
              aria-label={`Criterion ${i + 1}`}
              value={c}
              onChange={(e) => setCriterion(i, e.target.value)}
            />
            <button
              type="button"
              className="ib bad"
              aria-label={`Remove Criterion ${i + 1}`}
              title="Remove"
              disabled={form.criteria.length <= MIN}
              onClick={() => edit({ criteria: form.criteria.filter((_, j) => j !== i) })}
            >
              <TrashIcon />
            </button>
          </li>
        ))}
      </ol>
      <div className="row">
        {form.criteria.length < MAX && (
          <button type="button" className="link" onClick={() => edit({ criteria: [...form.criteria, ""] })}>
            + Criterion
          </button>
        )}
      </div>
      {draft.error && <p className="error">{draft.error.message}</p>}

      <div className="row">
        <button className="btn" type="submit" disabled={save.isPending}>
          {assignmentId ? "Save" : "Set Assignment"}
        </button>
        {saved && !save.isPending && <span className="muted small" role="status">Saved</span>}
      </div>
      {save.error && <p className="error">{save.error.message}</p>}
    </form>
  );
}
