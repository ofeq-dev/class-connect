import { useSyncExternalStore } from "react";

/**
 * The Diagnostics flag (FR-LC-6): off by default, kept per browser. Only when it is on do Lecturer
 * requests ask for IPs, blocks and device IDs (?diagnostics=1); the server leaves them out otherwise.
 */
const KEY = "cc.diagnostics";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let current = read();

export function setDiagnostics(on: boolean): void {
  current = on;
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the flag still holds for this page.
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDiagnostics(): boolean {
  return useSyncExternalStore(subscribe, () => current, () => false);
}

/** The query a Lecturer request adds while Diagnostics is on. */
export const diagnosticsQuery = (on: boolean) => ({ diagnostics: on ? ("1" as const) : undefined });
