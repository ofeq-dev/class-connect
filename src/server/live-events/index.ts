import type { Notice } from "../../shared/notices";

export { streamLiveEvents } from "./sse";

export type Role = "lecturer" | "student" | "projector";

/** Who a notice is for. "all" means the Lecturer and the Students of the Course. */
export type Audience = Role | "all";

/**
 * A subscriber's scope: one Course (or none, for Lecturer pages above any Course) and one role.
 * A Lecturer subscribed to a Course also gets Lecturer-wide notices (Course null).
 */
export interface Scope {
  courseId: number | null;
  role: Role;
}

export type Listener = (notice: Notice) => void;

export interface LiveEvents {
  publish(courseId: number | null, audience: Audience, notice: Notice): void;
  subscribe(scope: Scope, listener: Listener): () => void;
}

export function reaches(scope: Scope, courseId: number | null, audience: Audience): boolean {
  const roleMatches =
    audience === scope.role || (audience === "all" && scope.role !== "projector");
  if (!roleMatches) return false;
  if (scope.courseId === courseId) return true;
  return courseId === null && scope.role === "lecturer";
}

/** The in-process event bus. */
export function createLiveEvents(): LiveEvents {
  const subscribers = new Set<{ scope: Scope; listener: Listener }>();
  return {
    publish(courseId, audience, notice) {
      for (const s of subscribers) {
        if (reaches(s.scope, courseId, audience)) s.listener(notice);
      }
    },
    subscribe(scope, listener) {
      const entry = { scope, listener };
      subscribers.add(entry);
      return () => subscribers.delete(entry);
    },
  };
}
