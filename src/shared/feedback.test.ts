import { describe, expect, it } from "vitest";
import { openByTopic } from "./feedback";

describe("openByTopic", () => {
  it("counts New and Pinned Comments per Topic, most open first, leaving out Topics with none open", () => {
    const c = (topicId: number, topicName: string, status: "new" | "pinned" | "addressed" | "ignored") => ({
      topicId,
      topicName,
      status,
    });
    expect(
      openByTopic([
        c(1, "General", "new"),
        c(2, "Session 30 Nov", "new"),
        c(2, "Session 30 Nov", "pinned"),
        c(2, "Session 30 Nov", "addressed"),
        c(3, "Exam", "ignored"),
        c(1, "General", "addressed"),
      ]),
    ).toEqual([
      { topicId: 2, name: "Session 30 Nov", open: 2 },
      { topicId: 1, name: "General", open: 1 },
    ]);
  });
});
