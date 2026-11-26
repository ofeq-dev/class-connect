/** The only time source any module reads. Tests pass FakeClock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** The app's time zone: Session dates and times are wall-clock times here. */
export const DEFAULT_TIME_ZONE = "Asia/Jerusalem";

/** The local date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}
