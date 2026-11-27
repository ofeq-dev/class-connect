import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api, ok } from "../api";
import { useStudentPolls } from "./queries";

type Polls = NonNullable<ReturnType<typeof useStudentPolls>["data"]>;
type Poll = Polls["open"][number];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Open Polls not yet voted on: the badge on the Polls tab. */
export const unvoted = (polls: Polls | undefined) => polls?.open.filter((p) => p.myVote === null).length ?? 0;

/**
 * "New poll: …" when a Poll opens while the Student is on another tab. Never jumps tabs: the banner
 * links to Polls, and goes once seen or dismissed.
 */
export function useNewPollBanner(polls: Polls | undefined, onPollsTab: boolean) {
  const seen = useRef<Set<number> | null>(null);
  const [banner, setBanner] = useState<Poll | null>(null);
  useEffect(() => {
    if (!polls) return;
    const open = polls.open;
    // The Polls already open when the app loads aren't news.
    if (seen.current === null) seen.current = new Set(open.map((p) => p.id));
    const fresh = open.filter((p) => !seen.current!.has(p.id));
    for (const p of open) seen.current.add(p.id);
    if (onPollsTab) setBanner(null);
    else if (fresh.length) setBanner(fresh[fresh.length - 1]!);
    else if (banner && !open.some((p) => p.id === banner.id)) setBanner(null);
  }, [polls, onPollsTab, banner]);
  return { banner, dismiss: () => setBanner(null) };
}

export function NewPollBanner({ poll, dismiss }: { poll: Poll; dismiss: () => void }) {
  return (
    <div className="st-banner" role="status">
      <Link to="/polls" onClick={dismiss}>
        <b>New poll:</b> <span dir="auto">{poll.question}</span>
      </Link>
      <button type="button" className="link" aria-label="Dismiss" onClick={dismiss}>✕</button>
    </div>
  );
}

/** The Polls tab: open Polls first (tap an answer to vote), then past results. */
export function PollsTab() {
  const polls = useStudentPolls();
  const data = polls.data;
  return (
    <>
      <h1 className="tab-title">
        <span className="hl">Polls</span>
      </h1>
      {polls.error && <p className="err">{polls.error.message}</p>}
      {data && (
        <>
          {data.open.length ? (
            data.open.map((p) => <PollCard key={p.id} poll={p} />)
          ) : (
            <p className="empty">No open polls right now. When your Lecturer opens one, it shows here and you vote with one tap.</p>
          )}
          {data.closed.length > 0 && (
            <>
              <h2 className="st-h2">Results</h2>
              {data.closed.map((p) => (
                <PollCard key={p.id} poll={p} />
              ))}
            </>
          )}
        </>
      )}
    </>
  );
}

function PollCard({ poll }: { poll: Poll }) {
  const client = useQueryClient();
  const vote = useMutation({
    mutationFn: async (optionId: number) =>
      ok(await api.api.student.polls[":pollId"].vote.$post({ param: { pollId: String(poll.id) }, json: { optionId } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["student", "polls"] }),
    onError: () => client.invalidateQueries({ queryKey: ["student", "polls"] }),
  });
  const open = poll.status === "open";
  // Show the tapped answer at once; the refetch confirms it.
  const mine = vote.isPending ? vote.variables : poll.myVote;

  return (
    <div className="st-poll">
      <div className="st-poll-meta">
        {open ? <span className="live">Open poll</span> : <span>Closed</span>}
        <span>{poll.topicName}</span>
      </div>
      <div className="st-poll-q" dir="auto">{poll.question}</div>
      <div className="opts" role={open ? "radiogroup" : undefined} aria-label={open ? poll.question : undefined}>
        {poll.options.map((o) => {
          if (open) {
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                className="opt"
                aria-checked={mine === o.id}
                onClick={() => mine !== o.id && vote.mutate(o.id)}
              >
                <span className="radio" aria-hidden="true" />
                <span dir="auto">{o.label}</span>
              </button>
            );
          }
          const pct = poll.votes ? Math.round(((o.votes ?? 0) * 100) / poll.votes) : 0;
          return (
            <div key={o.id} className={`res ${mine === o.id ? "mine" : ""}`}>
              <div className="bar" style={{ width: `${pct}%` }} />
              <span dir="auto">
                {o.label}
                {mine === o.id && " · your vote"}
              </span>
              <b>{pct}%</b>
            </div>
          );
        })}
      </div>
      {vote.error && <p className="err">{vote.error.message}</p>}
      <div className="st-poll-foot">
        {open
          ? `${mine === null ? "Tap an answer to vote." : "Vote saved. Tap another answer to change it."} You’ll see results when the poll closes.`
          : plural(poll.votes ?? 0, "vote")}
      </div>
    </div>
  );
}
