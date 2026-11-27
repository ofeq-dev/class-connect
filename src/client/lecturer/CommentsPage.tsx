import { useState } from "react";
import { Link, useParams } from "react-router";
import { CommentMeta, useSetStatus, type LecturerComment } from "./CommentsColumn";
import { BackIcon, CheckIcon, IgnoreIcon, PinIcon } from "./icons";
import {
  STATUS_LABEL,
  useComments,
  useCourse,
  useCourseLive,
  useRoster,
  useTopics,
  type CommentQuery,
  type CommentStatus,
} from "./queries";

/** Every Comment of the Course outside the live Session, filtered by Topic, Student, status and timing. */
export function CommentsPage() {
  const { courseId = "" } = useParams();
  useCourseLive(courseId);
  const course = useCourse(courseId);
  const topics = useTopics(courseId, true);
  const roster = useRoster(courseId);
  const [filter, setFilter] = useState<CommentQuery>({});
  const comments = useComments(courseId, filter);
  const setStatus = useSetStatus(courseId);
  const set = (key: keyof CommentQuery) => (e: { target: { value: string } }) => setFilter({ ...filter, [key]: e.target.value });
  const act = (c: LecturerComment, status: CommentStatus) =>
    setStatus.mutate({ before: [{ id: c.id, status: c.status }], status });

  return (
    <div className="page">
      <header className="top">
        <div className="top-stack">
          <Link className="crumb" to={`/lecturer/courses/${courseId}`}>← {course.data?.name ?? "Course"}</Link>
          <span className="title">All comments</span>
        </div>
      </header>
      <section className="sec" data-s="cm">
        <div className="form-row" role="group" aria-label="Filters">
          <label className="field">
            <span>Topic</span>
            <select value={filter.topicId ?? ""} onChange={set("topicId")}>
              <option value="">All Topics</option>
              {topics.data?.map((x) => (
                <option key={x.id} value={x.id}>{x.name}{x.archived ? " (archived)" : ""}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Student</span>
            <select value={filter.author ?? ""} onChange={set("author")}>
              <option value="">Everyone</option>
              <option value="anonymous">Anonymous</option>
              {roster.data?.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Status</span>
            <select value={filter.status ?? ""} onChange={set("status")}>
              <option value="">Any status</option>
              {(Object.keys(STATUS_LABEL) as CommentStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>When</span>
            <select value={filter.timing ?? ""} onChange={set("timing")}>
              <option value="">Any time</option>
              <option value="before">Before the Session</option>
              <option value="during">During the Session</option>
              <option value="after">After the Session</option>
            </select>
          </label>
        </div>
        {comments.error && <p className="error">{comments.error.message}</p>}
        {comments.data?.length === 0 && <p className="empty">No Comments match.</p>}
        <div className="cm-list">
          {comments.data?.map((c) => (
            <div className={`card cm ${c.status === "pinned" ? "pinned" : ""}`} key={c.id}>
              <div className="body">
                <div className={`cm-text ${c.status === "addressed" || c.status === "ignored" ? "muted" : ""}`}>{c.text}</div>
                <div className="cm-meta">
                  <CommentMeta c={c} />
                  <span className="num">{new Date(c.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                  <span className={`chip ${c.status === "new" ? "c-ok" : "c-mute"}`}>{STATUS_LABEL[c.status]}</span>
                </div>
              </div>
              <span className="icons">
                {c.status === "new" || c.status === "pinned" ? (
                  <>
                    <button
                      className={`ib ${c.status === "pinned" ? "on" : ""}`}
                      aria-label={c.status === "pinned" ? "Unpin" : "Pin to top"}
                      aria-pressed={c.status === "pinned"}
                      title={c.status === "pinned" ? "Unpin" : "Pin to top"}
                      onClick={() => act(c, c.status === "pinned" ? "new" : "pinned")}
                    >
                      <PinIcon />
                    </button>
                    <button className="ib ok" aria-label="Addressed" title="Addressed" onClick={() => act(c, "addressed")}>
                      <CheckIcon />
                    </button>
                    <button className="ib bad" aria-label="Ignore" title="Ignore" onClick={() => act(c, "ignored")}>
                      <IgnoreIcon />
                    </button>
                  </>
                ) : (
                  <button className="ib" aria-label="Back to the list" title="Back to the list" onClick={() => act(c, "new")}>
                    <BackIcon />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
        {setStatus.error && <p className="error">{setStatus.error.message}</p>}
        {setStatus.toast}
      </section>
    </div>
  );
}
