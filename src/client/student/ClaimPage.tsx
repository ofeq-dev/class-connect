import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useParams } from "react-router";
import { api, ApiError, ok } from "../api";
import { useQrEntry } from "./queries";

type Step = { step: "id" } | { step: "confirm"; studentId: string; name: string } | { step: "taken" };

/**
 * /s/<code>, the page the Session QR code opens. Loading it checks a claimed phone in (the server
 * does it, no tap) and goes straight to Today, which shows the result. A new phone enters its
 * student ID and confirms its name first; the claim checks it in the same way.
 */
export function ClaimPage() {
  const { code = "" } = useParams();
  const entry = useQrEntry(code);
  const client = useQueryClient();
  const [studentId, setStudentId] = useState("");
  const [flow, setFlow] = useState<Step>({ step: "id" });

  const refused = (err: Error) => {
    if (err instanceof ApiError && err.code === "claim.already-claimed") setFlow({ step: "taken" });
  };
  const lookup = useMutation({
    mutationFn: async (id: string) =>
      ok(await api.api.student.s[":code"].lookup.$post({ param: { code }, json: { studentId: id } })),
    onSuccess: ({ name }, id) => setFlow({ step: "confirm", studentId: id, name }),
    onError: refused,
  });
  const claim = useMutation({
    mutationFn: async (id: string) =>
      ok(await api.api.student.s[":code"].claim.$post({ param: { code }, json: { studentId: id } })),
    // The claim has checked the phone in too: show it as claimed (to the app) without loading /s/<code> again.
    onSuccess: ({ checkIn, ...me }) => {
      client.setQueryData(["student", "entry", code], (old: typeof entry.data) => old && { ...old, me, checkIn });
      void client.invalidateQueries({ queryKey: ["student", "me"] });
    },
    onError: refused,
  });
  const claimed = !!entry.data?.me;
  useEffect(() => {
    // Loading this page checked the phone in; Today must show it, not what it last cached.
    if (claimed) void client.invalidateQueries({ queryKey: ["student", "me"] });
  }, [claimed, client]);

  if (entry.isPending) return null;
  if (entry.error) {
    return (
      <Flow eyebrow="Class Connect" title="This code doesn't open a Session">
        <p>Scan the QR code the Lecturer shows on the board again.</p>
      </Flow>
    );
  }
  if (entry.data.me) return <Navigate to="/" replace />;
  const course = entry.data.course.name;

  if (flow.step === "taken") {
    return (
      <Flow eyebrow={course} title="Already claimed — ask your Lecturer">
        <p>
          Someone has already set up this student ID on another phone. Your Lecturer can reset it, then scan the
          code again.
        </p>
        <div className="grow" />
        <button type="button" className="btn btn-big btn-ghost" onClick={() => setFlow({ step: "id" })}>
          Try another student ID
        </button>
      </Flow>
    );
  }

  if (flow.step === "confirm") {
    return (
      <Flow eyebrow={`Student ID ${flow.studentId}`} title={`You are ${flow.name}. Correct?`}>
        <p>This phone becomes yours for {course}. If anything goes wrong, your Lecturer can reset it.</p>
        {claim.error && !(claim.error instanceof ApiError && claim.error.code === "claim.already-claimed") && (
          <p className="err" role="alert">
            {claim.error.message}
          </p>
        )}
        <div className="grow" />
        <button
          type="button"
          className="btn btn-big"
          disabled={claim.isPending}
          onClick={() => claim.mutate(flow.studentId)}
        >
          Yes, that’s me
        </button>
        <button type="button" className="btn btn-big btn-ghost" onClick={() => setFlow({ step: "id" })}>
          No, go back
        </button>
      </Flow>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const id = studentId.trim();
    if (id) lookup.mutate(id);
  }

  return (
    <Flow eyebrow={`${course} · Check-in`} title="Who are you?">
      <p>First time on this phone. Enter your student ID once and this phone will remember you for the Course.</p>
      <form onSubmit={submit}>
        <label className="lbl" htmlFor="claim-id">
          Student ID
        </label>
        <input
          id="claim-id"
          className="id-input"
          inputMode="numeric"
          autoComplete="off"
          autoFocus
          value={studentId}
          onChange={(e) => setStudentId(e.target.value)}
          aria-invalid={lookup.isError}
          aria-describedby={lookup.isError ? "claim-err" : undefined}
        />
        {lookup.error && (
          <p className="err" id="claim-err" role="alert">
            {lookup.error.message}
          </p>
        )}
        <button className="btn btn-big" type="submit" disabled={!studentId.trim() || lookup.isPending}>
          Continue
        </button>
      </form>
    </Flow>
  );
}

function Flow({ eyebrow, title, children }: { eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <main className="flow">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {children}
    </main>
  );
}
