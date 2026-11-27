import type { SetTimer } from "../jobs";
import type { FakeClock } from "./fake-clock";

/** setTimeout on the fake Clock: tests move the Clock, then fire what has come due. */
export class FakeTimers {
  private pending: { at: number; fn: () => void }[] = [];
  constructor(private readonly clock: FakeClock) {}

  readonly setTimer: SetTimer = (fn, ms) => {
    const entry = { at: this.clock.now().getTime() + ms, fn };
    this.pending.push(entry);
    return () => {
      this.pending = this.pending.filter((e) => e !== entry);
    };
  };

  /** When the earliest pending timer fires, or null. */
  next(): Date | null {
    const at = Math.min(...this.pending.map((e) => e.at));
    return Number.isFinite(at) ? new Date(at) : null;
  }

  /** Fires every timer due on the Clock, earliest first, including any they set that are due too. */
  fireDue(): void {
    for (;;) {
      const due = this.pending.filter((e) => e.at <= this.clock.now().getTime()).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      this.pending = this.pending.filter((e) => e !== due);
      due.fn();
    }
  }
}
