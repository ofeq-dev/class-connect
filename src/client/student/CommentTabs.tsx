import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { REACTIONS } from "../../shared/reactions";
import { api, ok } from "../api";
import { useToast } from "../toast";
import { useMyComments, useStudentTopics } from "./queries";

const STATUS = { new: "New", pinned: "Pinned", addressed: "Addressed", ignored: "Ignored" } as const;

function useDelete() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (commentId: number) =>
      ok(await api.api.student.comments[":commentId"].$delete({ param: { commentId: String(commentId) } })),
    onSettled: () => client.invalidateQueries({ queryKey: ["student", "mine"] }),
  });
}

/** The Comment tab: Topic list, one-tap quick reactions, a text box, the anonymous switch and Send. */
export function CommentTab({ myName }: { myName: string }) {
  const topics = useStudentTopics();
  const client = useQueryClient();
  const toast = useToast();
  const remove = useDelete();
  const [chosen, setChosen] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const topicId = chosen ?? topics.data?.[0]?.id ?? null;

  const send = useMutation({
    mutationFn: async (input: { text?: string; reaction?: string }) =>
      ok(await api.api.student.comments.$post({ json: { topicId: topicId ?? 0, anonymous, text: input.text, reaction: input.reaction } })),
    onSuccess: (comment, input) => {
      if (input.text !== undefined) setText("");
      void client.invalidateQueries({ queryKey: ["student", "mine"] });
      const what = input.reaction ? `“${comment.text}” sent` : "Sent";
      toast.show(`${what} ${comment.anonymous ? "anonymously" : "with your name"}`, () => remove.mutate(comment.id));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim()) send.mutate({ text });
  }

  return (
    <>
      <h1 className="tab-title">
        <span className="hl">Message the Lecturer</span>
      </h1>
      <form className="cm-form" onSubmit={submit}>
        <span className="lbl" id="about">About</span>
        <div className="topics" role="radiogroup" aria-labelledby="about">
          {topics.data?.map((x) => (
            <button
              key={x.id}
              type="button"
              role="radio"
              aria-checked={topicId === x.id}
              className="trow"
              onClick={() => setChosen(x.id)}
            >
              <span className="radio" aria-hidden="true" />
              <span dir="auto">{x.name}</span>
            </button>
          ))}
        </div>
        <div className="reactions" role="group" aria-label="Quick reactions">
          {REACTIONS.map((r) => (
            <button
              key={r.key}
              type="button"
              className="reaction"
              disabled={!topicId || send.isPending}
              onClick={() => send.mutate({ reaction: r.key })}
            >
              {r.label}
            </button>
          ))}
        </div>
        <textarea
          rows={4}
          dir="auto"
          aria-label="Comment"
          placeholder="What do you want to tell the Lecturer?"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="switch-row">
          <span>
            <b>Send anonymously</b>
            <small>{anonymous ? "The Lecturer won’t see your name." : `The Lecturer will see it’s from ${myName}.`}</small>
          </span>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={anonymous}
            aria-label="Send anonymously"
            onClick={() => setAnonymous(!anonymous)}
          />
        </div>
        <button className="btn btn-big" type="submit" disabled={!topicId || !text.trim() || send.isPending}>
          Send to the Lecturer
        </button>
        {send.error && <p className="err">{send.error.message}</p>}
        {remove.error && <p className="err">{remove.error.message}</p>}
      </form>
      {toast.view}
    </>
  );
}

/** The Mine tab: this Student's own Comments with their status; delete while still New. */
export function MineTab() {
  const mine = useMyComments();
  const remove = useDelete();
  return (
    <>
      <h1 className="tab-title">
        <span className="hl">Your comments</span>
      </h1>
      <p className="empty">Only you and the Lecturer see these. You can delete one until the Lecturer deals with it.</p>
      {mine.data?.length === 0 && <p className="empty">Nothing sent yet.</p>}
      <ul className="cms">
        {mine.data?.map((c) => (
          <li className="cm" key={c.id}>
            <div className="cm-top">
              <span className={`st-chip st-${c.status}`}>{STATUS[c.status]}</span>
              <span className="cm-meta">
                {c.topicName}
                {c.timing && ` · ${c.timing} the Session`}
                {" · "}
                {new Date(c.createdAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <p dir="auto">{c.text}</p>
            <div className="cm-meta">
              {c.anonymous ? "Sent anonymously" : "Sent with your name"}
              {c.status === "new" && (
                <>
                  {" · "}
                  <button type="button" className="link" disabled={remove.isPending} onClick={() => remove.mutate(c.id)}>
                    Delete
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      {remove.error && <p className="err">{remove.error.message}</p>}
    </>
  );
}
