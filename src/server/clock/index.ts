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

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** How far a time zone's wall clock is ahead of UTC at an instant, in ms. */
function zoneOffset(instant: Date, timeZone: string): number {
  let format = partsFormatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partsFormatters.set(timeZone, format);
  }
  const p = Object.fromEntries(format.formatToParts(instant).map((x) => [x.type, Number(x.value)]));
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return wall - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The first instant of the next local day after an instant: the midnight that ends its day. */
export function nextLocalMidnight(instant: Date, timeZone: string): Date {
  const [y, m, d] = localDate(instant, timeZone).split("-").map(Number) as [number, number, number];
  const wallMidnight = Date.UTC(y, m - 1, d + 1);
  // Correct twice so a DST change on that day still lands on local midnight.
  let guess = wallMidnight - zoneOffset(instant, timeZone);
  guess = wallMidnight - zoneOffset(new Date(guess), timeZone);
  return new Date(guess);
}

/** The instant a wall-clock date (YYYY-MM-DD) and time (HH:MM) name in a time zone. */
export function localInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Correct twice so a time near a DST change still lands on the right instant.
  let guess = wall - zoneOffset(new Date(wall), timeZone);
  guess = wall - zoneOffset(new Date(guess), timeZone);
  return new Date(guess);
}
