/** "10:18" for an instant, in the browser's own time zone. */
export const clockTime = (at: string | Date) =>
  new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** An instant as a datetime-local input value, in the browser's time zone. */
export function localInput(at: string | Date): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
