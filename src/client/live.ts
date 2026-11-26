import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Notice, NoticeType } from "../shared/notices";

/**
 * Which queries each notice makes stale. Typed over every NoticeType, so a notice the server
 * can publish without an entry here fails the type check.
 */
export const noticeQueryKeys: { [T in NoticeType]: (id: number) => QueryKey[] } = {
  "course.changed": (id) => [["courses"], ["course", id]],
  "roster.changed": (courseId) => [["roster", courseId]],
  "session.changed": (id) => [["sessions"], ["session", id]],
  // A summary change may also have spent LLM requests.
  "summary.changed": (sessionId) => [["summary", sessionId], ["summaries"], ["llm-usage"]],
};

export function applyNotice(client: QueryClient, notice: Notice): void {
  const keys = noticeQueryKeys[notice.type]?.(notice.id) ?? [];
  for (const queryKey of keys) void client.invalidateQueries({ queryKey });
}

/** After a reconnect the stream has no backlog, so everything may be stale. */
export function applyReconnect(client: QueryClient): void {
  void client.invalidateQueries();
}

/** Opens the page's SSE stream and refetches on each notice. */
export function useLiveEvents(url: string | null): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url, { withCredentials: true });
    let opened = false;
    source.onopen = () => {
      if (opened) applyReconnect(client);
      opened = true;
    };
    source.onmessage = (event: MessageEvent<string>) => {
      applyNotice(client, JSON.parse(event.data) as Notice);
    };
    return () => source.close();
  }, [url, client]);
}
