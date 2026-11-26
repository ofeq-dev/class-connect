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

  it("course.changed refetches the Course list and nothing else", () => {
    const client = clientWith(["courses"], ["other"]);
    applyNotice(client, { type: "course.changed", id: 1 });
    expect(stale(client, ["courses"])).toBe(true);
    expect(stale(client, ["other"])).toBe(false);
  });

  it("a reconnect makes every query stale", () => {
    const client = clientWith(["courses"], ["other"]);
    applyReconnect(client);
    expect(stale(client, ["courses"])).toBe(true);
    expect(stale(client, ["other"])).toBe(true);
  });
});
