import type { Notice } from "../../shared/notices";
import { createLiveEvents, type Audience, type LiveEvents, type Listener, type Scope } from "../live-events";

export interface RecordedNotice {
  courseId: number | null;
  audience: Audience;
  notice: Notice;
}

/**
 * Records every notice with its scope, and still delivers to subscribers through the real
 * in-process bus, so the same fake serves module tests and end-to-end SSE tests.
 */
export class RecordingEvents implements LiveEvents {
  readonly published: RecordedNotice[] = [];
  private readonly bus = createLiveEvents();

  publish(courseId: number | null, audience: Audience, notice: Notice): void {
    this.published.push({ courseId, audience, notice });
    this.bus.publish(courseId, audience, notice);
  }
  subscribe(scope: Scope, listener: Listener): () => void {
    return this.bus.subscribe(scope, listener);
  }
  clear(): void {
    this.published.length = 0;
  }
}
