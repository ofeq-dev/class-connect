/** The only time source any module reads. Tests pass FakeClock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
