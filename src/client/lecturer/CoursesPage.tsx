import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, ok } from "../api";
import { useLiveEvents } from "../live";

export function CoursesPage() {
  useLiveEvents("/api/lecturer/events");
  const client = useQueryClient();
  const courses = useQuery({
    queryKey: ["courses"],
    queryFn: async () => ok(await api.api.lecturer.courses.$get()),
  });

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: async () => ok(await api.api.lecturer.courses.$post({ json: { name } })),
    onSuccess: () => {
      setName("");
      setAdding(false);
      return client.invalidateQueries({ queryKey: ["courses"] });
    },
  });
  const signOut = useMutation({
    mutationFn: async () => ok(await api.api.lecturer.session.$delete()),
    onSuccess: () => client.invalidateQueries({ queryKey: ["lecturer", "me"] }),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <div className="page">
      <header className="top">
        <span className="title">Class Connect</span>
        <button className="link" onClick={() => signOut.mutate()}>
          Sign out
        </button>
      </header>

      <section className="sec">
        <div className="sec-head">
          <h2>
            <span className="hl">Your Courses</span>
          </h2>
          {!adding && (
            <button className="btn-line" onClick={() => setAdding(true)}>
              + New Course
            </button>
          )}
        </div>

        {adding && (
          <form className="row" onSubmit={submit}>
            <input
              type="text"
              aria-label="Course name"
              placeholder="Course name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="btn" type="submit" disabled={!name.trim() || create.isPending}>
              Create
            </button>
            <button className="link" type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
            {create.error && <p className="error">{create.error.message}</p>}
          </form>
        )}

        {courses.data?.length === 0 && !adding && (
          <p className="empty">No Courses yet. Create one to import its Roster and add Sessions.</p>
        )}
        <div className="cards">
          {courses.data?.map((course) => (
            <article className="card" key={course.id}>
              <h3>{course.name}</h3>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
