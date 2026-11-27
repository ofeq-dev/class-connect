import { setDiagnostics, useDiagnostics } from "./diagnostics";

/** The ⋯ menu's Diagnostics switch: shows network blocks, IP addresses and device IDs while on. */
export function DiagnosticsItem() {
  const on = useDiagnostics();
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={on} className="menu-check" onClick={() => setDiagnostics(!on)}>
      <span className="grow">Diagnostics</span>
      <span className={on ? "chip c-warn" : "chip c-mute"}>{on ? "On" : "Off"}</span>
    </button>
  );
}
