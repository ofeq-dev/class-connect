import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { api, ok } from "../api";
import { dueLabel, useStudentAssignment, type StudentAssignmentView } from "./queries";

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
            {a.state !== "open" && " · past the due date"}
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
            <SubmissionForm assignmentId={assignmentId} replacing={!!a.submission} late={a.state !== "open"} />
          ) : (
            <p className="empty">The due date has passed, so your Submission can’t be replaced.</p>
          )}
          {a.review && <ReviewSection levels={a.review.levels} />}
          {a.classSummary && <ClassSummarySection summary={a.classSummary} />}
          {a.classSummaryHidden && (
            <p className="empty">The class summary is hidden: fewer than 5 Submissions went into it.</p>
          )}
          {a.help.length > 0 && <HelpSection assignmentId={assignmentId} help={a.help} matchDeadline={a.matchDeadline} />}
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

const LEVEL_LABEL = { "not-yet": "Not yet", partly: "Partly", secure: "Secure" } as const;

/** The Student's own released Review: a level, evidence and feedback per Criterion. */
function ReviewSection({ levels }: { levels: NonNullable<StudentAssignmentView["review"]>["levels"] }) {
  return (
    <section className="hw-review" aria-label="Your Review">
      <p className="lbl">Your Review</p>
      <ul>
        {levels.map((l) => (
          <li key={l.criterionId}>
            <b dir="auto">{l.label}</b> <span className={`hw-level hw-${l.level}`}>{LEVEL_LABEL[l.level]}</span>
            {l.evidence && <q dir="auto">{l.evidence}</q>}
            <p dir="auto">{l.feedback}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Anonymised counts per Criterion and common mistakes: no names, no anyone's work. */
function ClassSummarySection({ summary }: { summary: NonNullable<StudentAssignmentView["classSummary"]> }) {
  return (
    <section className="hw-review" aria-label="How the class did">
      <p className="lbl">How the class did</p>
      <ul>
        {summary.counts.map((c) => (
          <li key={c.criterionId}>
            <b dir="auto">{c.label}</b>
            <span className="hw-counts">
              Not yet {c.notYet} · Partly {c.partly} · Secure {c.secure}
            </span>
          </li>
        ))}
      </ul>
      {summary.commonMistakes.length > 0 && (
        <>
          <p className="lbl">Common mistakes</p>
          <ul className="hw-mistakes">
            {summary.commonMistakes.map((m) => <li key={m} dir="auto">{m}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}

/** Ask for or offer help per Criterion, then the outcome of the matching pass. */
function HelpSection({
  assignmentId,
  help,
  matchDeadline,
}: {
  assignmentId: string;
  help: StudentAssignmentView["help"];
  matchDeadline: string | null;
}) {
  const client = useQueryClient();
  const act = useMutation({
    mutationFn: async ({ criterionId, kind }: { criterionId: number; kind: "request" | "offer" }) => {
      const route = api.api.student.assignments[":assignmentId"].help[":criterionId"][kind];
      return ok(await route.$post({ param: { assignmentId, criterionId: String(criterionId) } }));
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["student", "assignment", Number(assignmentId)] }),
  });
  return (
    <section className="hw-review" aria-label="Help">
      <p className="lbl">Help</p>
      {matchDeadline && help.some((h) => ["can-ask", "can-offer", "asked", "offered"].includes(h.state.kind)) && (
        <p className="bd-when">Pairs are made by {dueLabel(matchDeadline)}. Nobody sees anyone’s level.</p>
      )}
      <ul>
        {help.map((h, i) => {
          const q = `Q${i + 1}`;
          const s = h.state;
          return (
            <li key={h.criterionId} className="hw-help">
              <b dir="auto">{q} · {h.label}</b>
              {s.kind === "can-ask" && (
                <button className="btn" disabled={act.isPending} onClick={() => act.mutate({ criterionId: h.criterionId, kind: "request" })}>
                  Ask for help
                </button>
              )}
              {s.kind === "can-offer" && (
                <button className="btn" disabled={act.isPending} onClick={() => act.mutate({ criterionId: h.criterionId, kind: "offer" })}>
                  Offer to help
                </button>
              )}
              {s.kind === "asked" && <span>Asked. You’ll hear who can help once pairs are made.</span>}
              {s.kind === "offered" && <span>Offered. You’ll hear who you’re helping once pairs are made.</span>}
              {s.kind === "paired" && <span role="status">You and {s.with.join(" and ")} are paired for {q}.</span>}
              {s.kind === "no-helper" && <span role="status">No Helper this time — ask your Lecturer.</span>}
              {s.kind === "thanks" && <span role="status">Thank you for offering. Nobody needed a Helper for {q} this time.</span>}
            </li>
          );
        })}
      </ul>
      {act.error && <p className="err">{act.error.message}</p>}
    </section>
  );
}
