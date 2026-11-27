import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api, ok } from "../api";
import { dueLabel, useStudentAssignment } from "./queries";

const MAX_BYTES = 10 * 1024 * 1024;

/** Base64 of a file's bytes, for the JSON body. */
async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** An Assignment on the phone: instructions, due date and the Submission form (text or PDF). */
export function AssignmentPage() {
  const { assignmentId = "" } = useParams();
  const assignment = useStudentAssignment(assignmentId);
  const a = assignment.data;

  return (
    <>
      <Link className="st-back" to="/">← Today</Link>
      {assignment.error && <p className="err">{assignment.error.message}</p>}
      {a && (
        <>
          <h1 className="tab-title"><span className="hl">{a.title}</span></h1>
          <p className="bd-when">
            Due {dueLabel(a.dueAt)}
            {a.state === "due" && " · past the due date"}
          </p>
          <p className="hw-instructions" dir="auto">{a.instructions}</p>
          <div>
            <p className="lbl">Your work is read against</p>
            <ul className="hw-criteria">
              {a.criteria.map((c) => <li key={c.id} dir="auto">{c.label}</li>)}
            </ul>
          </div>

          {a.submission && (
            <div className="hw-handed" role="status">
              <b>Handed in {dueLabel(a.submission.submittedAt)}</b>
              {a.submission.late && <span className="hw-late">Late</span>}
              <span>{a.submission.fileName ?? "Pasted text"}</span>
            </div>
          )}
          {a.canReplace ? (
            <SubmissionForm assignmentId={assignmentId} replacing={!!a.submission} late={a.state === "due"} />
          ) : (
            <p className="empty">The due date has passed, so your Submission can’t be replaced.</p>
          )}
        </>
      )}
    </>
  );
}

function SubmissionForm({ assignmentId, replacing, late }: { assignmentId: string; replacing: boolean; late: boolean }) {
  const client = useQueryClient();
  const [mode, setMode] = useState<"text" | "pdf">("text");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: async () => {
      const route = api.api.student.assignments[":assignmentId"].submission;
      const json =
        mode === "pdf" && file
          ? { text: undefined, pdfBase64: await base64(file), fileName: file.name }
          : { text, pdfBase64: undefined, fileName: "" };
      return ok(await route.$post({ param: { assignmentId }, json }));
    },
    onSuccess: async () => {
      setText("");
      setFile(null);
      await client.invalidateQueries({ queryKey: ["student", "assignment", Number(assignmentId)] });
      await client.invalidateQueries({ queryKey: ["student", "assignments"] });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    if (mode === "pdf") {
      if (!file) return setProblem("Choose a PDF first.");
      if (file.size > MAX_BYTES) return setProblem("That PDF is over 10 MB.");
    } else if (!text.trim()) {
      return setProblem("Paste your work first.");
    }
    if (replacing && !confirm("Replace your Submission with this one?")) return;
    send.mutate();
  }

  return (
    <form className="hw-form" onSubmit={submit}>
      <p className="lbl">{replacing ? "Replace your Submission" : "Hand in"}</p>
      {late && <p className="err">The due date has passed: this Submission will be marked Late.</p>}
      <div className="hw-modes" role="radiogroup" aria-label="Hand in as">
        <label><input type="radio" checked={mode === "text"} onChange={() => setMode("text")} /> Paste text</label>
        <label><input type="radio" checked={mode === "pdf"} onChange={() => setMode("pdf")} /> Upload a PDF</label>
      </div>
      {mode === "text" ? (
        <textarea
          aria-label="Your work"
          dir="auto"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <input
          type="file"
          aria-label="Your PDF"
          accept="application/pdf,.pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      )}
      {(problem ?? send.error) && <p className="err">{problem ?? send.error?.message}</p>}
      <button className="btn btn-big" type="submit" disabled={send.isPending}>
        {send.isPending ? "Sending…" : replacing ? "Replace" : "Hand in"}
      </button>
    </form>
  );
}
