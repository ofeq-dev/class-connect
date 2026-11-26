import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { NOTICE_TYPES } from "../shared/notices";
import { applyNotice, applyReconnect, noticeQueryKeys } from "./live";

function clientWith(...keys: string[][]) {
  const client = new QueryClient();
  for (const key of keys) client.setQueryData(key, "cached");
  return client;
}
const stale = (client: QueryClient, key: string[]) => client.getQueryState(key)?.isInvalidated;

describe("notice → query keys", () => {
  it("has an entry for every notice type the server publishes", () => {
    for (const type of NOTICE_TYPES) expect(noticeQueryKeys[type], type).toBeTypeOf("function");
  });

  it("course.changed refetches the Course list and that Course only", () => {
    const client = clientWith(["courses"], ["course", "1"], ["course", "2"]);
    applyNotice(client, { type: "course.changed", id: 1 });
    expect(stale(client, ["courses"])).toBe(true);
    expect(client.getQueryState(["course", 1])).toBeUndefined();
  });

  it("maps each notice to the keys of the thing that changed", () => {
    const client = new QueryClient();
    for (const key of [["course", 1], ["course", 2], ["roster", 1], ["roster", 2], ["sessions", 1], ["session", 5], ["session", 6]]) {
      client.setQueryData(key, "cached");
    }
    const staleKeys = () =>
      client
        .getQueryCache()
        .getAll()
        .filter((q) => q.state.isInvalidated)
        .map((q) => q.queryKey);

    applyNotice(client, { type: "course.changed", id: 1 });
    applyNotice(client, { type: "roster.changed", id: 2 });
    applyNotice(client, { type: "session.changed", id: 5 });
    expect(staleKeys()).toEqual([["course", 1], ["roster", 2], ["sessions", 1], ["session", 5]]);
  });

  it("a reconnect makes every query stale", () => {
    const client = clientWith(["courses"], ["other"]);
    applyReconnect(client);
    expect(stale(client, ["courses"])).toBe(true);
    expect(stale(client, ["other"])).toBe(true);
  });
});
