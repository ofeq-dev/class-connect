import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, ok } from "../api";
import { ProjectorView } from "../projector/ProjectorView";
import { formatDate, projectorUrl, useProjector, useSessions } from "./queries";

/** The one Projector window this console opened, kept across console pages so it can be brought forward. */
let projectorWindow: Window | null = null;

function useWindowOpen() {
  const [open, setOpen] = useState(() => !!projectorWindow && !projectorWindow.closed);
  useEffect(() => {
    const timer = setInterval(() => setOpen(!!projectorWindow && !projectorWindow.closed), 1000);
    return () => clearInterval(timer);
  }, []);
  return [open, setOpen] as const;
}

const MODES = [
  { mode: "qr", label: "QR + count" },
  { mode: "blank", label: "Blank" },
] as const;

/**
 * The console header's projector control: QR + count / Blank for this Session, a live thumbnail of
 * what the class sees (the same picture the window draws, from the same server state), and the
 * button that opens the window. The mode is server state, so a classroom PC agrees too.
 */
export function ProjectorControl({ courseId, sessionId }: { courseId: string; sessionId: string }) {
  const client = useQueryClient();
  const projector = useProjector(courseId);
  const sessions = useSessions(courseId);
  const [windowOpen, setWindowOpen] = useWindowOpen();
  const [blocked, setBlocked] = useState(false);

  const setMode = useMutation({
    mutationFn: async (projectorMode: "qr" | "blank") =>
      ok(
        await api.api.lecturer.courses[":courseId"].sessions[":sessionId"].$patch({
          param: { courseId, sessionId },
          json: { projectorMode },
        }),
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ["projector"] }),
  });

  const view = projector.data?.view;
  const ours = view?.sessionId === Number(sessionId);
  const current = ours ? view?.mode : null;
  const other = view && view.sessionId !== null && !ours ? sessions.data?.sessions.find((s) => s.id === view.sessionId) : null;

  function openWindow() {
    if (!projector.data) return;
    if (projectorWindow && !projectorWindow.closed) {
      projectorWindow.focus();
      return;
    }
    projectorWindow = window.open(projectorUrl(projector.data.secret), "cc-projector", "width=1280,height=720");
    setBlocked(!projectorWindow);
    setWindowOpen(!!projectorWindow);
  }

  function choose(mode: "qr" | "blank") {
    setMode.mutate(mode);
    if (!projectorWindow || projectorWindow.closed) openWindow();
  }

  return (
    <div className="projctl">
      <div className="projctl-side">
        <span className="small muted" aria-live="polite">
          {blocked
            ? "The browser blocked the window. Allow pop-ups for this site."
            : windowOpen
              ? "The class sees"
              : "Projector window not open"}
        </span>
        <span className="seg" role="group" aria-label="What the projector shows">
          {MODES.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              aria-pressed={current === mode}
              disabled={!projector.data || setMode.isPending}
              onClick={() => choose(mode)}
            >
              {label}
            </button>
          ))}
        </span>
        {other && (
          <span className="small muted">Showing the {formatDate(other.date)} Session</span>
        )}
        {setMode.error && <span className="error small" role="alert">{setMode.error.message}</span>}
      </div>
      <button
        type="button"
        className="thumb"
        onClick={openWindow}
        disabled={!projector.data}
        title={windowOpen ? "Bring the projector window forward" : "Open projector window"}
        aria-label={windowOpen ? "Bring the projector window forward" : "Open projector window"}
      >
        {view && <ProjectorView view={view} origin={window.location.origin} />}
        {!windowOpen && <span className="off">Open projector window</span>}
      </button>
    </div>
  );
}
