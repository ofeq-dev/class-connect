import { useMemo } from "react";
import type { ProjectorView as View } from "../../server/http/projector";
import { qrModules } from "./qr";
import "./projector.css";

export type { View };

/** "Monday 30 November" for a YYYY-MM-DD date, without shifting it through a time zone. */
function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

function QrCode({ text }: { text: string }) {
  const { size, path } = useMemo(() => qrModules(text), [text]);
  const quiet = 4; // The spec's quiet zone, in modules.
  return (
    <svg
      viewBox={`${-quiet} ${-quiet} ${size + 2 * quiet} ${size + 2 * quiet}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code to check in"
    >
      <rect x={-quiet} y={-quiet} width={size + 2 * quiet} height={size + 2 * quiet} fill="#fff" />
      <path d={path} fill="#111" />
    </svg>
  );
}

const SAY = {
  open: "Scan with your phone camera to check in",
  "not-opened": "Scan with your phone camera. Check-in opens soon.",
  closed: "Check-in is closed.",
} as const;

/**
 * What the class sees, at 16:9 and always light: the QR code, the Session and the live checked-in
 * count, or Blank. Sized in container units so the console thumbnail is the same picture, smaller.
 */
export function ProjectorView({ view, origin }: { view: View; origin: string }) {
  if (view.mode === "blank") {
    return (
      <div className="proj blank" aria-label="Blank">
        <span>Class Connect</span>
      </div>
    );
  }
  const { session, checkedIn, window } = view;
  const host = new URL(origin).host;
  return (
    <div className="proj">
      <div className="qr">
        <QrCode text={`${origin}/s/${session.qrCode}`} />
      </div>
      <div className="col">
        <div className="p-course">{view.courseName}</div>
        <h1>
          {longDate(session.date)}
          <br />
          <span className="p-time">
            {session.start}–{session.end}
          </span>
        </h1>
        <div className="p-say">{SAY[window]}</div>
        <div className="p-count" aria-live="polite">
          <span className="p-big">
            <span className="p-hl">{checkedIn}</span>
          </span>
          <span className="p-say">checked in</span>
        </div>
        <div className="p-url">{host}</div>
      </div>
    </div>
  );
}
