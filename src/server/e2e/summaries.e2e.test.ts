import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aCourse, aSession, listen, makeTestApp, openSse, signInLecturer, type TestApp } from "../testing";

let t: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let cookie: string;

beforeEach(async () => {
  t = makeTestApp();
  server = await listen(t);
  cookie = await signInLecturer(server.url);
});
afterEach(async () => {
  await server.close();
  t.close();
});

const call = (method: string, path: string, json?: unknown) =>
  fetch(`${server.url}/api/lecturer${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });

describe("Session summaries over HTTP", () => {
  it("uploads a Transcript, generates a draft and notifies the Course desk", async () => {
    const courseId = aCourse(t).id;
    const sessionId = aSession(t, courseId).id;
    const base = `/courses/${courseId}/sessions/${sessionId}/summary`;
    t.fakes.llm.reply("summarise", {
      overview: "Requirements.",
      outline: [{ start: null, topic: "Requirements" }],
      keyPoints: ["What, not how."],
      reviewQuestions: ["One?", "Two?", "Three?"],
    });
    const stream = await openSse(`${server.url}/api/lecturer/events?course=${courseId}`, cookie);

    const uploaded = await (await call("POST", `${base}/transcript`, { text: "We covered requirements." })).json();
    expect(uploaded).toMatchObject({ warning: "No timestamps found — the outline won't have times." });
    expect(await stream.nextMessage()).toEqual({ type: "summary.changed", id: sessionId });

    const generating = await call("POST", `${base}/generate`);
    expect(await generating.json()).toMatchObject({ state: "summarising" });
    await t.jobs.runDue();

    expect(await (await call("GET", base)).json()).toMatchObject({ state: "draft", versions: [{ author: "ai" }] });
    expect(await (await call("GET", `/courses/${courseId}/summaries`)).json()).toEqual([
      { sessionId, state: "draft", error: null },
    ]);
    expect(await (await call("GET", "/llm-usage")).json()).toEqual({ today: 1, limit: 1000 });
    stream.close();
  });

  it("refuses Generate without a Transcript, and another Course's Session", async () => {
    const courseId = aCourse(t).id;
    const sessionId = aSession(t, courseId).id;
    const res = await call("POST", `/courses/${courseId}/sessions/${sessionId}/summary/generate`);
    expect(res.status).toBe(400);
    const other = aCourse(t, "Other").id;
    expect((await call("GET", `/courses/${other}/sessions/${sessionId}/summary`)).status).toBe(404);
  });
});
