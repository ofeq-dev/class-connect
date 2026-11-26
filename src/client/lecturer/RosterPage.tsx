import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api, ok } from "../api";
import { ResetIcon } from "./icons";
import { useCourse, useCourseLive, useRoster } from "./queries";

type Report = { added: number; alreadyOnRoster: number; problems: { line: number; reason: string; raw: string }[] };

export function RosterPage() {
  const { courseId = "" } = useParams();
  useCourseLive(courseId);
  const course = useCourse(courseId);
  const roster = useRoster(courseId);
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ["roster", Number(courseId)] });
  const routes = api.api.lecturer.courses[":courseId"].roster;

  const [report, setReport] = useState<Report | null>(null);
  const importCsv = useMutation({
    mutationFn: async (csv: string) => ok(await routes.import.$post({ param: { courseId }, json: { csv } })),
    onSuccess: (r) => {
      setReport(r);
      return refresh();
    },
  });

  const [student, setStudent] = useState({ studentId: "", name: "" });
  const add = useMutation({
    mutationFn: async () => ok(await routes.$post({ param: { courseId }, json: student })),
    onSuccess: () => {
      setStudent({ studentId: "", name: "" });
      return refresh();
    },
  });

  const reset = useMutation({
    mutationFn: async (entryId: number) =>
      ok(await routes[":entryId"]["reset-claim"].$post({ param: { courseId, entryId: String(entryId) } })),
    onSuccess: refresh,
  });

  async function chooseFile(file: File | undefined) {
    if (file) importCsv.mutate(await file.text());
  }
  function submitAdd(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }

  const entries = roster.data ?? [];
  const claimed = entries.filter((e) => e.claimed).length;

  return (
    <div className="page">
      <header className="top">
        <div className="top-stack">
          <Link className="crumb" to={`/lecturer/courses/${courseId}`}>← {course.data?.name ?? "Course"}</Link>
          <span className="title">Roster</span>
        </div>
      </header>

      <div className="desk">
        <section className="sec" data-s="ros">
          <div className="sec-head"><h2><span className="hl">Import</span></h2></div>
          <p className="notice">
            A CSV with each Student's name and student ID, with or without a header row. Importing again adds
            only new student IDs.
          </p>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label="Roster CSV file"
            onChange={(e) => {
              void chooseFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          {importCsv.error && <p className="error">{importCsv.error.message}</p>}
          {report && (
            <div className={`report${report.problems.length ? " has-problems" : ""}`} role="status">
              <b>
                Added {report.added}
                {report.alreadyOnRoster > 0 && `, ${report.alreadyOnRoster} already on the Roster`}
                {report.problems.length > 0 && `, ${report.problems.length} not imported`}.
              </b>
              {report.problems.map((p) => (
                <span key={p.line}>
                  Line {p.line}: {p.reason} <span className="muted">({p.raw || "empty"})</span>
                </span>
              ))}
            </div>
          )}

          <div className="sec-head"><h2><span className="hl">Add one Student</span></h2></div>
          <form className="form-row" onSubmit={submitAdd}>
            <label className="field">
              <span>Student ID</span>
              <input type="text" required value={student.studentId} onChange={(e) => setStudent({ ...student, studentId: e.target.value })} />
            </label>
            <label className="field">
              <span>Name</span>
              <input type="text" required value={student.name} onChange={(e) => setStudent({ ...student, name: e.target.value })} />
            </label>
            <button className="btn" type="submit" disabled={add.isPending}>Add</button>
            {add.error && <p className="error">{add.error.message}</p>}
          </form>
        </section>

        <section className="sec" data-s="ros">
          <div className="sec-head">
            <h2><span className="hl">Students</span></h2>
            <span className="muted num">{entries.length} · {claimed} claimed</span>
          </div>
          {roster.data && entries.length === 0 && <p className="empty">Nobody on the Roster yet.</p>}
          <ul className="list">
            {entries.map((e) => (
              <li key={e.id}>
                <span className="grow">
                  <b dir="auto">{e.name}</b> <span className="muted num">{e.studentId}</span>
                </span>
                {e.claimed ? <span className="chip c-ok">Claimed</span> : <span className="chip c-mute">Not claimed</span>}
                <button
                  className="ib"
                  aria-label={`Reset ${e.name}'s Claim`}
                  title="Reset Claim"
                  disabled={!e.claimed || reset.isPending}
                  onClick={() => {
                    if (confirm(`Reset ${e.name}'s Claim? Their phone stops working until they claim again. Attendance is kept.`)) {
                      reset.mutate(e.id);
                    }
                  }}
                >
                  <ResetIcon />
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
