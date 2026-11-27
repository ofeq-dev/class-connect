import { clockTime } from "../time";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, ok } from "../api";
import { currentPoll, useProjector, useSessionPolls, useTopics, type LecturerPoll } from "./queries";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The live console's Poll column (pink): only the current Poll (focused, else open, else next
 * scheduled), the rest behind "All polls (n)", and "+ New poll". Totals are the Lecturer's alone.
 */
export function PollColumn(props: {
  courseId: string;
  sessionId: string;
  focus: number | null;
  setFocus: (id: number | null) => void;
}) {
  const { courseId, sessionId, focus, setFocus } = props;
  const client = useQueryClient();
  const polls = useSessionPolls(courseId, sessionId);
  const projector = useProjector(courseId);
  const [form, setForm] = useState<FormState | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const current = currentPoll(polls.data, focus);

  // An open Poll stays on the card after it closes (until Done), so it keeps the focus.
  useEffect(() => {
    if (focus === null && current?.status === "open") setFocus(current.id);
  }, [focus, current, setFocus]);

  const pollRoute = api.api.lecturer.courses[":courseId"].polls[":pollId"];
  const refetch = () => client.invalidateQueries({ queryKey: ["polls"] });
  const action = useMutation({
    mutationFn: async ({ id, verb }: { id: number; verb: "open" | "close" | "copy" }) => {
      const param = { courseId, pollId: String(id) };
      if (verb === "open") return ok(await pollRoute.open.$post({ param }));
      if (verb === "close") return ok(await pollRoute.close.$post({ param }));
      return ok(await pollRoute.copy.$post({ param }));
    },
    onSuccess: (poll, { verb }) => {
      void refetch();
      if (verb === "copy") setForm(formFrom(poll));
      else setFocus(poll.id);
    },
  });
  const project = useMutation({
    mutationFn: async (pollId: number | null) =>
      ok(
        await api.api.lecturer.courses[":courseId"].sessions[":sessionId"].$patch({
          param: { courseId, sessionId },
          json: pollId === null ? { projectorMode: "qr" } : { projectorMode: "poll", projectedPollId: pollId },
        }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["projector"] }),
  });

  const view = projector.data?.view;
  const onScreen = (p: LecturerPoll) => view?.mode === "poll" && view.poll.id === p.id;

  function done(p: LecturerPoll) {
    if (onScreen(p)) project.mutate(null);
    setFocus(null);
  }

  const error = action.error ?? project.error;
  return (
    <section className="sec" data-s="poll" aria-busy={!polls.data}>
      <div className="sec-head">
        <h2><span className="hl">Poll</span></h2>
      </div>
      {polls.error && <p className="error">{polls.error.message}</p>}
      {form ? (
        <PollForm
          courseId={courseId}
          sessionId={sessionId}
          initial={form}
          onDone={(poll) => {
            setForm(null);
            if (poll && poll.status === "open") setFocus(poll.id);
          }}
        />
      ) : (
        polls.data && (
          <>
            <Glance
              poll={current}
              onScreen={current ? onScreen(current) : false}
              busy={action.isPending || project.isPending}
              act={(verb) => current && action.mutate({ id: current.id, verb })}
              show={() => current && project.mutate(current.id)}
              done={() => current && done(current)}
              edit={() => current && setForm(formFrom(current))}
            />
            {(!current || (current.status !== "open" && current.status !== "closed")) && (
              <button className="btn-line" onClick={() => setForm(blankForm())}>+ New poll</button>
            )}
          </>
        )
      )}
      {error && <p className="error" role="alert">{error.message}</p>}
      {polls.data && polls.data.length > 0 && (
        <>
          <button className="more" onClick={() => setListOpen(!listOpen)} aria-expanded={listOpen}>
            {listOpen ? "▾" : "▸"} All polls ({polls.data.length})
          </button>
          {listOpen && (
            <div>
              {polls.data.map((p) => (
                <div className="prow" key={p.id}>
                  <StatusChip poll={p} />
                  <button className="grow" onClick={() => setFocus(p.id)} title="Show on the card">
                    {p.question || "Untitled poll"}
                    {p.status === "closed" && <span className="small muted"> {plural(p.votes, "vote")}</span>}
                  </button>
                  {(p.status === "draft" || p.status === "scheduled") && (
                    <button className="link small" onClick={() => setForm(formFrom(p))}>Edit</button>
                  )}
                  {p.status === "draft" && p.complete && (
                    <button className="btn-line btn-sm" onClick={() => action.mutate({ id: p.id, verb: "open" })}>Open</button>
                  )}
                  {p.status === "closed" && (
                    <button className="link small" onClick={() => action.mutate({ id: p.id, verb: "copy" })}>Copy</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function StatusChip({ poll }: { poll: LecturerPoll }) {
  if (poll.status === "open") return <span className="chip c-ok">Open</span>;
  if (poll.status === "scheduled") return <span className="chip c-warn">{poll.opensAt ? clockTime(poll.opensAt) : "Scheduled"}</span>;
  if (poll.status === "closed") return <span className="chip c-mute">Closed</span>;
  return <span className="chip c-mute">{poll.complete ? "Saved" : "Draft"}</span>;
}

function Bars({ poll }: { poll: LecturerPoll }) {
  return (
    <div className="bars">
      {poll.options.map((o) => {
        const pct = poll.votes ? Math.round((o.votes * 100) / poll.votes) : 0;
        return (
          <div className="bar" key={o.id}>
            <i style={{ width: `${pct}%` }} />
            <span dir="auto">{o.label}</span>
            <b>{o.votes}</b>
          </div>
        );
      })}
    </div>
  );
}

function Glance(props: {
  poll: LecturerPoll | undefined;
  onScreen: boolean;
  busy: boolean;
  act: (verb: "open" | "close") => void;
  show: () => void;
  done: () => void;
  edit: () => void;
}) {
  const { poll: p, onScreen, busy } = props;
  if (!p) return <p className="empty">No poll running.</p>;
  const question = <div className="poll-q" dir="auto">{p.question || "Untitled poll"}</div>;

  if (p.status === "open") {
    return (
      <>
        <div className="state">
          <span className="dot on" />
          <span className="grow" aria-live="polite">
            Open · {plural(p.votes, "vote")}
            {p.closesAt && ` · closes ${clockTime(p.closesAt)}`}
          </span>
        </div>
        {question}
        <Bars poll={p} />
        <div className="row">
          <button className="btn" disabled={busy} onClick={() => props.act("close")}>
            {onScreen ? "Close and show results" : "Close poll"}
          </button>
          {onScreen ? (
            <span className="chip c-ok">On projector</span>
          ) : (
            <button className="btn-line" disabled={busy} onClick={props.show}>Show on projector</button>
          )}
        </div>
      </>
    );
  }
  if (p.status === "closed") {
    return (
      <>
        <div className="state">
          <span className="dot" />
          <span className="grow">
            Closed{p.closesAt && ` ${clockTime(p.closesAt)}`} · {plural(p.votes, "vote")} · Students see the results
          </span>
        </div>
        {question}
        <Bars poll={p} />
        <div className="row">
          {onScreen ? (
            <span className="chip c-ok">Results on projector</span>
          ) : (
            <button className="btn" disabled={busy} onClick={props.show}>Show results on projector</button>
          )}
          <button className="btn-line" onClick={props.done}>Done</button>
        </div>
      </>
    );
  }
  if (p.status === "scheduled") {
    return (
      <>
        <div className="state">
          <span className="dot" />
          <span className="grow">Next poll opens {p.opensAt && clockTime(p.opensAt)}</span>
        </div>
        {question}
        <div className="row">
          <button className="btn-line btn-sm" disabled={busy} onClick={() => props.act("open")}>Open now</button>
          <button className="link small" onClick={props.edit}>Edit</button>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="state">
        <span className="dot" />
        <span className="grow">Saved · not open yet</span>
      </div>
      {question}
      <div className="row">
        {p.complete && (
          <button className="btn-line btn-sm" disabled={busy} onClick={() => props.act("open")}>Open now</button>
        )}
        <button className="link small" onClick={props.edit}>Edit</button>
      </div>
    </>
  );
}

interface FormState {
  editId?: number;
  topicId?: number;
  question: string;
  options: string[];
  opens: "now" | "at" | "later";
  openAt: string;
  closes: "hand" | "after";
  minutes: number;
}

const hhmm = (d: Date) => d.toTimeString().slice(0, 5);
const blankForm = (): FormState => ({
  question: "",
  options: ["", "", ""],
  opens: "now",
  openAt: hhmm(new Date(Date.now() + 10 * 60_000)),
  closes: "hand",
  minutes: 3,
});
const formFrom = (p: LecturerPoll): FormState => ({
  editId: p.status === "draft" || p.status === "scheduled" ? p.id : undefined,
  topicId: p.topicId,
  question: p.question,
  options: [...p.options.map((o) => o.label), ...(p.options.length < 2 ? [""] : [])],
  opens: p.status === "scheduled" ? "at" : "later",
  openAt: p.opensAt ? hhmm(new Date(p.opensAt)) : blankForm().openAt,
  closes: p.closeAfterMinutes ? "after" : "hand",
  minutes: p.closeAfterMinutes ?? 3,
});

/** "At" a time today, on this laptop's clock. */
function todayAt(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const d = new Date();
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.toISOString();
}

/** "+ New poll" (and Edit): question, 2–6 answers, Opens now / at a time / later, Closes by hand / after N min. */
function PollForm(props: {
  courseId: string;
  sessionId: string;
  initial: FormState;
  onDone: (poll: LecturerPoll | null) => void;
}) {
  const { courseId, sessionId } = props;
  const client = useQueryClient();
  const topics = useTopics(courseId);
  const [f, setF] = useState(props.initial);
  const set = (patch: Partial<FormState>) => setF((prev) => ({ ...prev, ...patch }));
  // Default Topic: this Session's.
  const sessionTopic = topics.data?.find((x) => x.kind === "session" && x.sessionId === Number(sessionId))?.id;
  const topicId = f.topicId ?? sessionTopic ?? topics.data?.[0]?.id;

  const save = useMutation({
    mutationFn: async () => {
      const json = {
        topicId: topicId ?? 0,
        question: f.question,
        options: f.options,
        opensAt: f.opens === "now" ? "now" : f.opens === "at" ? todayAt(f.openAt) : undefined,
        closeAfterMinutes: f.opens !== "later" && f.closes === "after" ? f.minutes : undefined,
      };
      const route = api.api.lecturer.courses[":courseId"].polls;
      return f.editId
        ? ok(await route[":pollId"].$put({ param: { courseId, pollId: String(f.editId) }, json }))
        : ok(await route.$post({ param: { courseId }, json }));
    },
    onSuccess: (poll) => {
      void client.invalidateQueries({ queryKey: ["polls"] });
      props.onDone(poll);
    },
  });

  return (
    <form
      className="card poll-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="field">
        <span>Question</span>
        <input
          type="text"
          dir="auto"
          value={f.question}
          placeholder="Ready for the exercise?"
          onChange={(e) => set({ question: e.target.value })}
          autoFocus
        />
      </label>
      <div className="field">
        <span>Answers</span>
        <div className="answers">
          {f.options.map((o, i) => (
            <input
              key={i}
              type="text"
              dir="auto"
              value={o}
              placeholder={`Answer ${i + 1}`}
              aria-label={`Answer ${i + 1}`}
              onChange={(e) => set({ options: f.options.map((x, j) => (j === i ? e.target.value : x)) })}
            />
          ))}
        </div>
        {f.options.length < 6 && (
          <button type="button" className="link small" style={{ alignSelf: "flex-start" }} onClick={() => set({ options: [...f.options, ""] })}>
            + answer
          </button>
        )}
      </div>
      {topics.data && topics.data.length > 1 && (
        <label className="field">
          <span>Topic</span>
          <select value={topicId} onChange={(e) => set({ topicId: Number(e.target.value) })}>
            {topics.data.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </label>
      )}
      <div className="field">
        <span>Opens</span>
        <div className="row">
          <span className="seg" role="group" aria-label="Opens">
            {(
              [
                ["now", "Now"],
                ["at", "At"],
                ["later", "Later"],
              ] as const
            ).map(([v, label]) => (
              <button key={v} type="button" aria-pressed={f.opens === v} onClick={() => set({ opens: v })}>
                {label}
              </button>
            ))}
          </span>
          {f.opens === "at" && (
            <input type="time" aria-label="Opens at" value={f.openAt} onChange={(e) => set({ openAt: e.target.value })} />
          )}
        </div>
      </div>
      {f.opens !== "later" ? (
        <div className="field">
          <span>Closes</span>
          <div className="row">
            <span className="seg" role="group" aria-label="Closes">
              {(
                [
                  ["hand", "When I close it"],
                  ["after", "After"],
                ] as const
              ).map(([v, label]) => (
                <button key={v} type="button" aria-pressed={f.closes === v} onClick={() => set({ closes: v })}>
                  {label}
                </button>
              ))}
            </span>
            {f.closes === "after" && (
              <>
                <select aria-label="Minutes" value={f.minutes} onChange={(e) => set({ minutes: Number(e.target.value) })}>
                  {[1, 2, 3, 5, 10].map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                min
              </>
            )}
          </div>
        </div>
      ) : (
        <span className="small muted">Saved polls can be half-written; finish them later.</span>
      )}
      {save.error && <p className="error" role="alert">{save.error.message}</p>}
      <div className="row">
        <button className="btn" type="submit" disabled={save.isPending || topicId === undefined}>
          {f.opens === "now" ? "Open poll" : f.opens === "at" ? "Schedule" : "Save"}
        </button>
        <button type="button" className="link" onClick={() => props.onDone(null)}>Cancel</button>
      </div>
    </form>
  );
}
