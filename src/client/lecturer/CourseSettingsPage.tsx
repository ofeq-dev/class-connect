import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api, ok } from "../api";
import { useCourse, useCourseLive } from "./queries";

export function CourseSettingsPage() {
  const { courseId = "" } = useParams();
  useCourseLive(courseId);
  const course = useCourse(courseId);
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [languages, setLanguages] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!course.data) return;
    setName(course.data.name);
    setLanguages(course.data.translationLanguages.join(", "));
  }, [course.data]);

  const save = useMutation({
    mutationFn: async () =>
      ok(
        await api.api.lecturer.courses[":courseId"].$patch({
          param: { courseId },
          json: { name, translationLanguages: languages.split(/[\s,]+/).filter(Boolean) },
        }),
      ),
    onSuccess: () => {
      setSaved(true);
      return client.invalidateQueries({ queryKey: ["course", Number(courseId)] });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    save.mutate();
  }

  return (
    <div className="page">
      <header className="top">
        <div className="top-stack">
          <Link className="crumb" to={`/lecturer/courses/${courseId}`}>← {course.data?.name ?? "Course"}</Link>
          <span className="title">Course settings</span>
        </div>
      </header>
      <form className="sec" style={{ maxWidth: 560 }} onSubmit={submit}>
        <label className="field">
          <span>Course name</span>
          <input type="text" required value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Translation languages for Session summaries</span>
          <input type="text" placeholder="e.g. ar, ru" value={languages} onChange={(e) => setLanguages(e.target.value)} />
        </label>
        <p className="notice">Language codes, separated by commas. Each published Session summary is translated into these.</p>
        {save.error && <p className="error">{save.error.message}</p>}
        <div className="row">
          <button className="btn" type="submit" disabled={save.isPending}>Save</button>
          {saved && <span className="muted" role="status">Saved.</span>}
        </div>
      </form>
    </div>
  );
}
