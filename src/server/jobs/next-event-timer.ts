import type { Clock } from "../clock";
import type { SetTimer } from "./index";

/** A module with scheduled moments: Attendance (midnight closes) and Feedback (Poll opens and closes). */
export interface MomentSource {
  /** The earliest scheduled moment strictly after `after`, or null. */
  nextMoment(after: Date): Date | null;
  /** Publishes the notices for every scheduled moment in (since, until]; changes nothing. */
  announce(since: Date, until: Date): void;
}

export interface NextEventTimer {
  /** At boot: arms the timer from what is stored. */
  start(): void;
  /** A module's schedule changed: re-arm at the new earliest moment. */
  recompute(): void;
  stop(): void;
}

/** setTimeout's limit; a later moment is re-armed when this fires. */
const MAX_DELAY = 2 ** 31 - 1;

const defaultTimer: SetTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/**
 * The next-event timer (docs/diagrams/sequence-diagrams.md): wakes at the earliest scheduled moment
 * any source reports and has it send its notices. Time-based states are read from the Clock, so the
 * timer never changes state; it only tells screens to refetch. Jobs keep their own timer at run_at.
 */
export function createNextEventTimer({
  clock,
  sources,
  setTimer = defaultTimer,
}: {
  clock: Clock;
  sources: MomentSource[];
  setTimer?: SetTimer;
}): NextEventTimer {
  let started = false;
  let cancel: (() => void) | null = null;
  /** Moments up to here have been announced. */
  let announcedTo = clock.now();

  function wake() {
    cancel = null;
    const now = clock.now();
    if (now > announcedTo) {
      for (const source of sources) source.announce(announcedTo, now);
      announcedTo = now;
    }
    arm();
  }

  function arm() {
    cancel?.();
    cancel = null;
    if (!started) return;
    // From the last announced moment, so one that passed before a late wake still fires (at once).
    const next = sources
      .map((s) => s.nextMoment(announcedTo))
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (!next) return;
    const delay = Math.min(Math.max(0, next.getTime() - clock.now().getTime()), MAX_DELAY);
    cancel = setTimer(wake, delay);
  }

  return {
    start() {
      started = true;
      announcedTo = clock.now();
      arm();
    },
    recompute: arm,
    stop() {
      started = false;
      cancel?.();
      cancel = null;
    },
  };
}
