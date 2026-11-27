import type { Clock } from "../clock";

/** Defaults to a fixed weekday morning: Monday 2026-11-30, 10:00 Israel time. */
export class FakeClock implements Clock {
  private current: Date;
  constructor(start = new Date("2026-11-30T08:00:00.000Z")) {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  set(instant: Date | string): void {
    this.current = new Date(instant);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
