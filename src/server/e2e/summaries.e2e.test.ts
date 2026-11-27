import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aClaimedStudent,
  aCourse,
  aSession,
  listen,
  makeTestApp,
  openSse,
  signInLecturer,
  type TestApp,
} from "../testing";

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

  it("edits, restores and publishes, and the claimed phone hears of it and reads only the published version", async () => {
    const courseId = aCourse(t).id;
    const sessionId = aSession(t, courseId).id;
    const { deviceToken } = aClaimedStudent(t, courseId);
    const phone = `cc_device=${deviceToken}`;
    const base = `/courses/${courseId}/sessions/${sessionId}/summary`;
    const student = (path: string, cookie = phone) =>
      fetch(`${server.url}/api/student${path}`, { headers: { cookie } });

    const saved = await (await call("POST", `${base}/versions`, { markdown: "## Overview\n\nFirst." })).json();
    expect(saved).toMatchObject({ state: "draft", versions: [{ number: 1, author: "lecturer" }] });
    const v1 = saved.versions[0].id;
    await call("POST", `${base}/versions`, { markdown: "## Overview\n\nSecond." });
    const restored = await (await call("POST", `${base}/versions/${v1}/restore`)).json();
    expect(restored.versions.map((v: { number: number }) => v.number)).toEqual([3, 2, 1]);

    expect(await (await student("/summaries")).json()).toEqual([]);
    expect((await student(`/summaries/${sessionId}`)).status).toBe(404);

    const stream = await openSse(`${server.url}/api/student/events`, phone);
    const published = await (await call("POST", `${base}/versions/${v1}/publish`)).json();
    expect(published).toMatchObject({ state: "published", publishedVersionId: v1 });
    expect(await stream.nextMessage()).toEqual({ type: "summary.changed", id: sessionId });
    stream.close();

    await call("POST", `${base}/versions`, { markdown: "Not published." });
    expect(await (await student("/summaries")).json()).toMatchObject([{ sessionId }]);
    expect(await (await student(`/summaries/${sessionId}`)).json()).toMatchObject({
      sessionId,
      markdown: "## Overview\n\nFirst.",
    });
    expect((await student(`/summaries/${sessionId}`, "")).status).toBe(404);
  });

  it("deletes a published summary with its Session, and the phone no longer lists it", async () => {
    const courseId = aCourse(t).id;
    const sessionId = aSession(t, courseId).id;
    const { deviceToken } = aClaimedStudent(t, courseId);
    const base = `/courses/${courseId}/sessions/${sessionId}/summary`;
    const v = (await (await call("POST", `${base}/versions`, { markdown: "Notes." })).json()).versions[0].id;
    await call("POST", `${base}/versions/${v}/publish`);
    expect((await call("DELETE", `/courses/${courseId}/sessions/${sessionId}`)).status).toBe(200);
    const list = await fetch(`${server.url}/api/student/summaries`, { headers: { cookie: `cc_device=${deviceToken}` } });
    expect(await list.json()).toEqual([]);
  });

  it("translates on publish; the phone hears when it's done and reads its language by ?lang=", async () => {
    const courseId = aCourse(t).id;
    const sessionId = aSession(t, courseId).id;
    t.modules.course.updateCourse(courseId, { translationLanguages: ["ar"] });
    t.fakes.llm.reply("translate", ({ markdown }: { markdown: string }) => ({ markdown: `عربي ${markdown}` }));
    const { deviceToken } = aClaimedStudent(t, courseId);
    const phone = `cc_device=${deviceToken}`;
    const base = `/courses/${courseId}/sessions/${sessionId}/summary`;
    const read = async (query: string) =>
      (await fetch(`${server.url}/api/student/summaries/${sessionId}${query}`, { headers: { cookie: phone } })).json();

    const v = (await (await call("POST", `${base}/versions`, { markdown: "Notes." })).json()).versions[0].id;
    const published = await (await call("POST", `${base}/versions/${v}/publish`)).json();
    expect(published.translations).toMatchObject([{ language: "ar", state: "translating" }]);

    const stream = await openSse(`${server.url}/api/student/events`, phone);
    await t.jobs.runDue();
    expect(await stream.nextMessage()).toEqual({ type: "summary.changed", id: sessionId });
    stream.close();

    expect(await read("?lang=ar")).toMatchObject({ markdown: "عربي Notes.", language: "ar", languages: ["ar"] });
    expect(await read("?lang=ru")).toMatchObject({ markdown: "Notes.", language: null });

    const edited = await (await call("PUT", `${base}/translations/ar`, { markdown: "مصحح" })).json();
    expect(edited.translations).toMatchObject([{ language: "ar", markdown: "مصحح", edited: true }]);
    expect(await read("?lang=ar")).toMatchObject({ markdown: "مصحح" });
    expect((await call("POST", `${base}/translations/ar/retry`)).status).toBe(400);
  });
});
