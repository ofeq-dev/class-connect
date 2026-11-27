import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type { TestApp } from "./make-test-app";
import { TEST_PASSWORD } from "./make-test-app";

/** Starts the Hono app on an ephemeral loopback port for end-to-end tests. */
export async function listen(t: TestApp): Promise<{ url: string; close: () => Promise<void> }> {
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: t.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        (server as Server).closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Signs the Lecturer in and returns the Cookie header value to send. */
export async function signInLecturer(url: string, password = TEST_PASSWORD): Promise<string> {
  const res = await fetch(`${url}/api/lecturer/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
  return cookieHeader(res);
}

export function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

export interface SseEvent {
  kind: "message" | "comment";
  data: string;
}

/** A minimal SSE reader over fetch: yields messages and comment lines (heartbeats) in order. */
export async function openSse(url: string, cookie: string) {
  const controller = new AbortController();
  const res = await fetch(url, { headers: { cookie }, signal: controller.signal });
  if (!res.body) throw new Error(`no SSE body (${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const queue: SseEvent[] = [];
  let buffer = "";
  // A read outlives a timeout, so the chunk it brings is kept for the next call rather than lost.
  let pending: ReturnType<typeof reader.read> | null = null;

  async function next(timeoutMs = 2000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    while (queue.length === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for an SSE event");
      pending ??= reader.read();
      const chunk = await Promise.race([
        pending,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timed out waiting for an SSE event")), remaining),
        ),
      ]);
      pending = null;
      if (chunk.done) throw new Error("SSE stream ended");
      buffer += chunk.value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (data) queue.push({ kind: "message", data });
        else if (block.startsWith(":")) queue.push({ kind: "comment", data: block.slice(1).trim() });
      }
    }
    return queue.shift()!;
  }

  async function nextMessage(timeoutMs?: number): Promise<unknown> {
    for (;;) {
      const event = await next(timeoutMs);
      if (event.kind === "message") return JSON.parse(event.data);
    }
  }

  return { status: res.status, next, nextMessage, close: () => controller.abort() };
}
