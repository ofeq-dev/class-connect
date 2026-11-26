import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { LiveEvents, Scope } from "./index";

/**
 * One SSE stream per page. Sends each notice in scope as a message, a comment heartbeat every
 * `heartbeatMs` (Cloudflare closes idle connections after ~100 s, ADR 0003), and no backlog.
 */
export function streamLiveEvents(c: Context, events: LiveEvents, scope: Scope, heartbeatMs: number) {
  return streamSSE(c, async (stream) => {
    const unsubscribe = events.subscribe(scope, (notice) => {
      void stream.writeSSE({ data: JSON.stringify(notice) });
    });
    const heartbeat = setInterval(() => void stream.write(": heartbeat\n\n"), heartbeatMs);
    let done!: () => void;
    const closed = new Promise<void>((resolve) => (done = resolve));
    stream.onAbort(() => {
      clearInterval(heartbeat);
      unsubscribe();
      done();
    });
    await stream.write(": connected\n\n");
    await closed;
  });
}
