import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api, ok } from "../api";
import { EditIcon, TrashIcon } from "./icons";
import { formatDate, useCourse, useCourseLive, useTopics } from "./queries";

/** General, one Topic per Session, and the named Topics the Lecturer adds, renames and archives. */
export function TopicsPage() {
  const { courseId = "" } = useParams();
  useCourseLive(courseId);
  const course = useCourse(courseId);
  const topics = useTopics(courseId, true);
  const client = useQueryClient();
  const routes = api.api.lecturer.courses[":courseId"].topics;
  const refresh = () => client.invalidateQueries({ queryKey: ["topics"] });

  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: async () => ok(await routes.$post({ param: { courseId }, json: { name } })),
    onSuccess: () => {
      setName("");
      return refresh();
    },
  });
  const archive = useMutation({
    mutationFn: async (topicId: number) =>
      ok(await routes[":topicId"].archive.$post({ param: { courseId, topicId: String(topicId) } })),
    onSuccess: refresh,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }

  const all = topics.data ?? [];
  const named = all.filter((x) => x.kind === "named" && !x.archived);
  const archived = all.filter((x) => x.archived);
  const fixed = all.filter((x) => x.kind !== "named");

  return (
    <div className="page">
      <header className="top">
        <div className="top-stack">
          <Link className="crumb" to={`/lecturer/courses/${courseId}`}>← {course.data?.name ?? "Course"}</Link>
          <span className="title">Topics</span>
        </div>
      </header>
      <section className="sec" data-s="cm">
        <div className="sec-head"><h2><span className="hl">Named Topics</span></h2></div>
        <p className="muted small">Students can comment on these besides the Sessions, for example an assignment or an exam.</p>
        <form className="form-row" onSubmit={submit}>
          <label className="field">
            <span>New Topic</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Assignment 2" />
          </label>
          <button className="btn" type="submit" disabled={add.isPending || !name.trim()}>Add</button>
        </form>
        {add.error && <p className="error">{add.error.message}</p>}
        {named.length === 0 && <p className="empty">No named Topics yet.</p>}
        <ul className="list" aria-label="Named Topics">
          {named.map((x) => (
            <NamedTopic key={x.id} courseId={courseId} topic={x} onArchive={() => archive.mutate(x.id)} />
          ))}
        </ul>
        {archive.error && <p className="error">{archive.error.message}</p>}
        {archived.length > 0 && (
          <>
            <h3 className="small muted">Archived (hidden from Students, Comments kept)</h3>
            <ul className="list" aria-label="Archived Topics">
              {archived.map((x) => <li key={x.id} className="muted">{x.name}</li>)}
            </ul>
          </>
        )}
      </section>
      <section className="sec" data-s="att">
        <div className="sec-head"><h2><span className="hl">Always there</span></h2></div>
        <ul className="list">
          {fixed.map((x) => (
            <li key={x.id}>
              <span className="grow">{x.name}</span>
              {x.sessionDate && <span className="muted small">{formatDate(x.sessionDate)}</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function NamedTopic(props: { courseId: string; topic: { id: number; name: string }; onArchive: () => void }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(props.topic.name);
  const rename = useMutation({
    mutationFn: async () =>
      ok(
        await api.api.lecturer.courses[":courseId"].topics[":topicId"].$patch({
          param: { courseId: props.courseId, topicId: String(props.topic.id) },
          json: { name },
        }),
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["topics"] });
      setEditing(false);
    },
  });
  if (editing) {
    return (
      <li>
        <form className="form-row grow" onSubmit={(e) => { e.preventDefault(); rename.mutate(); }}>
          <input type="text" aria-label="Topic name" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn" type="submit" disabled={rename.isPending}>Save</button>
          <button className="link" type="button" onClick={() => setEditing(false)}>Cancel</button>
          {rename.error && <p className="error">{rename.error.message}</p>}
        </form>
      </li>
    );
  }
  return (
    <li>
      <span className="grow">{props.topic.name}</span>
      <button className="ib" aria-label="Rename Topic" title="Rename" onClick={() => setEditing(true)}>
        <EditIcon />
      </button>
      <button
        className="ib bad"
        aria-label="Archive Topic"
        title="Archive"
        onClick={() => {
          if (confirm(`Archive "${props.topic.name}"? Students won't see it; its Comments are kept.`)) props.onArchive();
        }}
      >
        <TrashIcon />
      </button>
    </li>
  );
}
