import { describe, expect, it } from "vitest";
import type { Notice } from "../../shared/notices";
import { createLiveEvents, type Scope } from "./index";

const notice: Notice = { type: "course.changed", id: 1 };

function collect(scope: Scope) {
  const bus = createLiveEvents();
  const got: Notice[] = [];
  const unsubscribe = bus.subscribe(scope, (n) => got.push(n));
  return { bus, got, unsubscribe };
}

describe("Live events", () => {
  it("reaches only subscribers in the notice's Course and role", () => {
    const bus = createLiveEvents();
    const seen: string[] = [];
    const scopes: [string, Scope][] = [
      ["lecturer@1", { courseId: 1, role: "lecturer" }],
      ["student@1", { courseId: 1, role: "student" }],
      ["student@2", { courseId: 2, role: "student" }],
      ["projector@1", { courseId: 1, role: "projector" }],
    ];
    for (const [name, scope] of scopes) bus.subscribe(scope, () => seen.push(name));

    bus.publish(1, "student", notice);
    expect(seen).toEqual(["student@1"]);

    seen.length = 0;
    bus.publish(1, "all", notice);
    expect(seen).toEqual(["lecturer@1", "student@1"]);
  });

  it("sends Lecturer-wide notices to every Lecturer stream and never to Students", () => {
    const lecturer = collect({ courseId: 7, role: "lecturer" });
    lecturer.bus.publish(null, "lecturer", notice);
    expect(lecturer.got).toEqual([notice]);

    const scoped = collect({ courseId: 3, role: "student" });
    scoped.bus.publish(null, "all", notice);
    expect(scoped.got).toEqual([]);
  });

  it("stops delivering after a subscriber unsubscribes", () => {
    const { bus, got, unsubscribe } = collect({ courseId: 1, role: "lecturer" });
    unsubscribe();
    bus.publish(1, "lecturer", notice);
    expect(got).toEqual([]);
  });
});
