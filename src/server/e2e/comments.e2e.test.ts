import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../course";
import {
  aClaimedStudent,
  aCourse,
  aRoster,
  aSession,
  listen,
  makeTestApp,
  openSse,
  signInLecturer,
  type TestApp,
} from "../testing";

let t: TestApp;
let server: Awaited<ReturnType<typeof listen>>;
let courseId: number;
let session: Session;
let lecturer: string;
let dana: string;
let omar: string;

beforeEach(async () => {
  t = makeTestApp();
  courseId = aCourse(t).id;
  aRoster(t, courseId, 3); // 1001 Dana Levi, 1002 Omar Haddad, 1003 Irina Petrova
  session = aSession(t, courseId);
  dana = `cc_device=${aClaimedStudent(t, courseId, "1001").deviceToken}`;
  omar = `cc_device=${aClaimedStudent(t, courseId, "1002").deviceToken}`;
  server = await listen(t);
  lecturer = await signInLecturer(server.url);
});
afterEach(async () => {
  await server.close();
  t.close();
});

const headers = (cookie: string) => ({ "content-type": "application/json", cookie });
const get = (path: string, cookie = "") => fetch(`${server.url}${path}`, { headers: headers(cookie) });
const send = (method: string, path: string, body: unknown, cookie = "") =>
  fetch(`${server.url}${path}`, { method, headers: headers(cookie), body: JSON.stringify(body) });
const lecturerPath = (rest: string) => `/api/lecturer/courses/${courseId}${rest}`;

async function sessionTopicId(cookie: string): Promise<number> {
  const topics = (await (await get("/api/student/topics", cookie)).json()) as { id: number; kind: string }[];
  return topics.find((x) => x.kind === "session")!.id;
}

describe("Comments, from the phone to the console", () => {
  it("a Student comments and sees it on Mine; the console sees it without the anonymous author", async () => {
    const topicId = await sessionTopicId(dana);
    expect((await send("POST", "/api/student/comments", { topicId, text: "Too abstract", anonymous: true }, dana)).status).toBe(201);
    expect((await send("POST", "/api/student/comments", { topicId, reaction: "too-fast" }, omar)).status).toBe(201);

    const mine = await (await get("/api/student/comments", dana)).json();
    expect(mine).toMatchObject([{ text: "Too abstract", anonymous: true, status: "new", timing: "during" }]);

    const inbox = await (await get(lecturerPath(`/sessions/${session.id}/comments`), lecturer)).text();
    expect(inbox).toContain("Too abstract");
    expect(inbox).toContain("Omar Haddad");
    expect(inbox).not.toContain("Dana");
  });

  it("refuses an unclaimed phone", async () => {
    const res = await send("POST", "/api/student/comments", { topicId: 1, text: "Hi" }, "cc_device=nobody");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "comment.unclaimed" });
  });

  it("the Lecturer sets a status, the Student sees it, and can no longer delete it", async () => {
    const topicId = await sessionTopicId(dana);
    const c = (await (await send("POST", "/api/student/comments", { topicId, text: "Q" }, dana)).json()) as { id: number };
    await send("POST", lecturerPath("/comments/status"), { ids: [c.id], status: "pinned" }, lecturer);
    expect(await (await get("/api/student/comments", dana)).json()).toMatchObject([{ status: "pinned" }]);
    expect((await send("DELETE", `/api/student/comments/${c.id}`, {}, dana)).status).toBe(400);
  });

  it("filters the all-comments screen", async () => {
    const topicId = await sessionTopicId(dana);
    await send("POST", "/api/student/comments", { topicId, text: "named" }, dana);
    await send("POST", "/api/student/comments", { topicId, text: "hidden", anonymous: true }, omar);
    const texts = async (query: string) =>
      ((await (await get(lecturerPath(`/comments?${query}`), lecturer)).json()) as { text: string }[]).map((c) => c.text);
    expect(await texts("author=anonymous")).toEqual(["hidden"]);
    expect(await texts(`topicId=${topicId}&timing=during&status=new`)).toEqual(["hidden", "named"]);
  });

  it("New Comments and status changes reach the Lecturer's stream, never a Student's", async () => {
    const console = await openSse(`${server.url}/api/lecturer/events?course=${courseId}`, lecturer);
    const phone = await openSse(`${server.url}/api/student/events`, omar);
    await console.next();
    await phone.next(); // ": connected"
    const topicId = await sessionTopicId(dana);

    const c = (await (await send("POST", "/api/student/comments", { topicId, text: "Q" }, dana)).json()) as { id: number };
    expect(await console.nextMessage()).toEqual({ type: "comment.changed", id: c.id });
    await send("POST", lecturerPath("/comments/status"), { ids: [c.id], status: "addressed" }, lecturer);
    expect(await console.nextMessage()).toEqual({ type: "comment.changed", id: c.id });
    await expect(phone.nextMessage(300)).rejects.toThrow(/timed out/);
    console.close();
    phone.close();
  });
});

describe("Topics, from the Course desk", () => {
  it("adds, renames and archives a named Topic; Students stop seeing it once archived", async () => {
    const created = (await (await send("POST", lecturerPath("/topics"), { name: "Midterm" }, lecturer)).json()) as { id: number };
    await send("PATCH", lecturerPath(`/topics/${created.id}`), { name: "Final exam" }, lecturer);
    const names = async (cookie: string, path: string) =>
      ((await (await get(path, cookie)).json()) as { name: string }[]).map((x) => x.name);
    expect(await names(dana, "/api/student/topics")).toEqual(["Session 1", "General", "Final exam"]);
    await send("POST", lecturerPath(`/topics/${created.id}/archive`), {}, lecturer);
    expect(await names(dana, "/api/student/topics")).toEqual(["Session 1", "General"]);
    expect(await names(lecturer, lecturerPath("/topics?archived=1"))).toContain("Final exam");
  });
});
