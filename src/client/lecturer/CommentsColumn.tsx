import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ok } from "../api";
import { useToast } from "../toast";
import { BackIcon, CheckIcon, IgnoreIcon, PinIcon } from "./icons";
import { formatTime, STATUS_LABEL, useInbox, type CommentStatus } from "./queries";

type Inbox = NonNullable<ReturnType<typeof useInbox>["data"]>;
type Item = Inbox["open"][number];
export type LecturerComment = Inbox["dealtWith"][number];

/** Sets statuses with Undo: the toast puts every Comment back to the status it had. */
export function useSetStatus(courseId: string) {
  const client = useQueryClient();
  const toast = useToast();
  const route = api.api.lecturer.courses[":courseId"].comments.status;
  const send = async (ids: number[], status: CommentStatus) =>
    ok(await route.$post({ param: { courseId }, json: { ids, status } }));

  const mutation = useMutation({
    mutationFn: async (change: { before: { id: number; status: CommentStatus }[]; status: CommentStatus }) => {
      await send(
        change.before.map((c) => c.id),
        change.status,
      );
    },
    onSuccess: (_, change) => {
      void client.invalidateQueries({ queryKey: ["comments"] });
      const n = change.before.length;
      const what = n === 1 ? "Comment" : `${n} Comments`;
      const message = change.status === "new" ? "Back in the list" : `${what} ${STATUS_LABEL[change.status].toLowerCase()}`;
      toast.show(message, () => {
        const byStatus = new Map<CommentStatus, { id: number }[]>();
        for (const c of change.before) byStatus.set(c.status, [...(byStatus.get(c.status) ?? []), c]);
        void Promise.all([...byStatus].map(([status, cs]) => send(cs.map((c) => c.id), status))).then(() =>
          client.invalidateQueries({ queryKey: ["comments"] }),
        );
      });
    },
  });
  return { mutate: mutation.mutate, error: mutation.error, toast: toast.view };
}

/** The live console's Comments column: Topic chips, pinned on top, grouped quick reactions, Dealt with. */
export function CommentsColumn({ courseId, sessionId }: { courseId: string; sessionId: string }) {
  const inbox = useInbox(courseId, sessionId);
  const setStatus = useSetStatus(courseId);
  const [topic, setTopic] = useState<number | "all">("all");
  const [showDone, setShowDone] = useState(false);
  const data = inbox.data;
  const sessionTopic = data?.topics[0]?.id;

  const inTopic = (item: Item | LecturerComment) =>
    topic === "all" || ("kind" in item && item.kind === "comment" ? item.comment.topicId : item.topicId) === topic;
  const pinned = data?.pinned.filter(inTopic) ?? [];
  const open = data?.open.filter(inTopic) ?? [];
  const done = data?.dealtWith.filter(inTopic) ?? [];
  const openCount = [...pinned, ...open].reduce((n, i) => n + (i.kind === "reactions" ? i.count : 1), 0);
  const allOpen = data?.topics.reduce((n, x) => n + x.open, 0) ?? 0;

  const act = (comments: { id: number; status: CommentStatus }[], status: CommentStatus) =>
    setStatus.mutate({ before: comments.map((c) => ({ id: c.id, status: c.status })), status });

  return (
    <section className="sec" data-s="cm" aria-busy={!data}>
      <div className="sec-head">
        <h2><span className="hl">Comments</span></h2>
        {data && <span className="small muted num">{openCount} open</span>}
      </div>
      {inbox.error && <p className="error">{inbox.error.message}</p>}
      {data && (
        <div className="filters" role="group" aria-label="Topic">
          <button className={topic === "all" ? "on" : ""} aria-pressed={topic === "all"} onClick={() => setTopic("all")}>
            All<b>{allOpen || ""}</b>
          </button>
          {data.topics.map((x) => (
            <button key={x.id} className={topic === x.id ? "on" : ""} aria-pressed={topic === x.id} onClick={() => setTopic(x.id)}>
              {x.name}<b>{x.open || ""}</b>
            </button>
          ))}
        </div>
      )}
      <div className="cm-list" aria-live="polite">
        {pinned.map((item) => (
          <ItemCard key={key(item)} item={item} pinned sessionTopic={sessionTopic} showTopic={topic === "all"} act={act} />
        ))}
        {open.map((item) => (
          <ItemCard key={key(item)} item={item} sessionTopic={sessionTopic} showTopic={topic === "all"} act={act} />
        ))}
        {data && !pinned.length && !open.length && <p className="empty">All caught up.</p>}
      </div>
      {data && (
        <button className="more" onClick={() => setShowDone(!showDone)} aria-expanded={showDone}>
          {showDone ? "▾" : "▸"} Dealt with ({done.length})
        </button>
      )}
      {showDone && (
        <div className="cm-list">
          {done.map((c) => (
            <div className="card cm" key={c.id}>
              <div className="body">
                <div className="cm-text muted">{c.text}</div>
                <div className="cm-meta">
                  <CommentMeta c={c} sessionTopic={sessionTopic} showTopic={topic === "all"} />
                  <span>{STATUS_LABEL[c.status]}</span>
                </div>
              </div>
              <span className="icons">
                <button className="ib" aria-label="Back to the list" title="Back to the list" onClick={() => act([c], "new")}>
                  <BackIcon />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {setStatus.error && <p className="error">{setStatus.error.message}</p>}
      {setStatus.toast}
    </section>
  );
}

const key = (item: Item) => (item.kind === "comment" ? `c${item.comment.id}` : `g${item.commentIds.join(",")}`);

type Act = (comments: { id: number; status: CommentStatus }[], status: CommentStatus) => void;

function ItemCard(props: { item: Item; pinned?: boolean; sessionTopic?: number; showTopic: boolean; act: Act }) {
  const { item, pinned = false, act } = props;
  const [who, setWho] = useState(false);
  const status: CommentStatus = pinned ? "pinned" : "new";
  const members = item.kind === "comment" ? [{ id: item.comment.id, status }] : item.commentIds.map((id) => ({ id, status }));
  const icons = (
    <span className="icons">
      <button
        className={`ib ${pinned ? "on" : ""}`}
        aria-label={pinned ? "Unpin" : "Pin to top"}
        aria-pressed={pinned}
        title={pinned ? "Unpin" : "Pin to top"}
        onClick={() => act(members, pinned ? "new" : "pinned")}
      >
        <PinIcon />
      </button>
      <button className="ib ok" aria-label="Addressed" title="Addressed" onClick={() => act(members, "addressed")}>
        <CheckIcon />
      </button>
      <button className="ib bad" aria-label="Ignore" title="Ignore" onClick={() => act(members, "ignored")}>
        <IgnoreIcon />
      </button>
    </span>
  );

  if (item.kind === "comment") {
    return (
      <div className={`card cm ${pinned ? "pinned" : ""}`}>
        <div className="body">
          <div className="cm-text">{item.comment.text}</div>
          <div className="cm-meta">
            <CommentMeta c={item.comment} sessionTopic={props.sessionTopic} showTopic={props.showTopic} />
          </div>
        </div>
        {icons}
      </div>
    );
  }
  const people = [...item.named, ...(item.anonymous ? [`${item.anonymous} anonymous`] : [])].join(", ");
  return (
    <div className={`card cm ${pinned ? "pinned" : ""}`}>
      <span className="n"><span className="hl">×{item.count}</span></span>
      <div className="body">
        <div className="cm-text"><b>{item.text}</b></div>
        <div className="cm-meta">
          {props.showTopic && item.topicId !== props.sessionTopic && <span>{item.topicName}</span>}
          <span className="num">{formatTime(item.from)}–{formatTime(item.to)}</span>
          {who && <span>{people}</span>}
          <button className="link small" onClick={() => setWho(!who)} aria-expanded={who}>
            {who ? "hide names" : "who?"}
          </button>
        </div>
      </div>
      {icons}
    </div>
  );
}

/** Author (or Anonymous), the Topic when it isn't this Session's, before / after, presence and time. */
export function CommentMeta({ c, sessionTopic, showTopic = true }: { c: LecturerComment; sessionTopic?: number; showTopic?: boolean }) {
  return (
    <>
      <b>{c.author?.name ?? "Anonymous"}</b>
      {showTopic && c.topicId !== sessionTopic && <span>{c.topicName}</span>}
      {c.timing && c.timing !== "during" && <span>{c.timing} the Session</span>}
      {c.present !== null && <span>{c.present ? "checked in" : "not checked in"}</span>}
      <span className="num">{formatTime(c.createdAt)}</span>
    </>
  );
}
