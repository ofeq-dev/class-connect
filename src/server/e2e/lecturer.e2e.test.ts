import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listen, openSse, signInLecturer, makeTestApp, type TestApp } from "../testing";

let t: TestApp;
let server: Awaited<ReturnType<typeof listen>>;

async function start(options?: Parameters<typeof makeTestApp>[0]) {
  t = makeTestApp(options);
  server = await listen(t);
}
afterEach(async () => {
  await server.close();
  t.close();
});

describe("Lecturer identity", () => {
  beforeEach(() => start());

  it("refuses a wrong password", async () => {
    const res = await fetch(`${server.url}/api/lecturer/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "nope" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("sets a signed, httpOnly, Secure, SameSite=Lax cookie for the right password", async () => {
    const res = await fetch(`${server.url}/api/lecturer/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    expect(res.status).toBe(200);
    const [cookie] = res.headers.getSetCookie();
    expect(cookie).toMatch(/^cc_lecturer=1\.[^;]+;/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it("refuses Lecturer routes without the cookie or with a forged one", async () => {
    expect((await fetch(`${server.url}/api/lecturer/courses`)).status).toBe(401);
    const forged = await fetch(`${server.url}/api/lecturer/courses`, {
      headers: { cookie: "cc_lecturer=1.forgedsignature" },
    });
    expect(forged.status).toBe(401);
    expect((await fetch(`${server.url}/api/lecturer/events`)).status).toBe(401);
  });

  it("lets a signed-in Lecturer create and list Courses", async () => {
    const cookie = await signInLecturer(server.url);
    const created = await fetch(`${server.url}/api/lecturer/courses`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Software Engineering" }),
    });
    expect(created.status).toBe(201);
    const list = await fetch(`${server.url}/api/lecturer/courses`, { headers: { cookie } });
    expect((await list.json()).map((c: { name: string }) => c.name)).toEqual(["Software Engineering"]);
  });

  it("answers a refused Course name with a 400 and the reason", async () => {
    const cookie = await signInLecturer(server.url);
    const res = await fetch(`${server.url}/api/lecturer/courses`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "  " }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "course.name-required" });
  });
});

describe("Live events over SSE", () => {
  it("tells a second Lecturer tab about a Course created in the first", async () => {
    await start();
    const cookie = await signInLecturer(server.url);
    const tab = await openSse(`${server.url}/api/lecturer/events`, cookie);
    expect(tab.status).toBe(200);
    expect(await tab.next()).toEqual({ kind: "comment", data: "connected" });

    const res = await fetch(`${server.url}/api/lecturer/courses`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Algorithms" }),
    });
    const { id } = await res.json();
    expect(await tab.nextMessage()).toEqual({ type: "course.changed", id });

    // Refetching after the notice shows the new Course.
    const list = await fetch(`${server.url}/api/lecturer/courses`, { headers: { cookie } });
    expect((await list.json()).map((c: { id: number }) => c.id)).toEqual([id]);
    tab.close();
  });

  it("sends a heartbeat on an idle stream within the configured interval", async () => {
    await start({ sseHeartbeatMs: 50 });
    const cookie = await signInLecturer(server.url);
    const tab = await openSse(`${server.url}/api/lecturer/events`, cookie);
    await tab.next(); // connected
    expect(await tab.next(500)).toEqual({ kind: "comment", data: "heartbeat" });
    tab.close();
  });

  it("replays no backlog to a stream that reconnects", async () => {
    await start();
    const cookie = await signInLecturer(server.url);
    const first = await openSse(`${server.url}/api/lecturer/events`, cookie);
    await first.next();
    first.close();
    t.modules.course.createCourse(t.lecturer.id, "While disconnected");

    const again = await openSse(`${server.url}/api/lecturer/events`, cookie);
    expect(await again.next()).toEqual({ kind: "comment", data: "connected" });
    await expect(again.next(200)).rejects.toThrow(/timed out/);
    again.close();
  });
});

describe("Health", () => {
  it("reports the commit SHA and the newest migration", async () => {
    await start();
    const res = await fetch(`${server.url}/healthz`);
    expect(await res.json()).toEqual({ sha: "test-sha", migration: "0000_lecturer_and_course" });
  });
});
