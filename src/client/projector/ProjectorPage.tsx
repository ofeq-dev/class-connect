import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { api, ApiError, ok } from "../api";
import { useLiveEvents } from "../live";
import { ProjectorView } from "./ProjectorView";

/**
 * /p/<secret>, the public Projector window: no sign-in, the unguessable link is the access. It
 * follows the Projector scope's notices, which carry only "the picture changed" and "the count changed".
 */
export function ProjectorPage() {
  const { secret = "" } = useParams();
  const view = useQuery({
    queryKey: ["projector", secret],
    queryFn: async () => ok(await api.api.projector[":secret"].$get({ param: { secret } })),
    // A classroom PC is left running: keep trying through a dropped connection, but not a replaced link.
    retry: (_, error) => !(error instanceof ApiError && error.status === 404),
    retryDelay: 5000,
  });
  const gone = view.error instanceof ApiError && view.error.status === 404;
  useLiveEvents(gone ? null : `/api/projector/${encodeURIComponent(secret)}/events`);
  const [fullScreen, setFullScreen] = useState(false);

  useEffect(() => {
    document.title = "Class Connect · Projector";
    const sync = () => setFullScreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  return (
    <div className="projector-page">
      {!fullScreen && document.fullscreenEnabled && (
        <button className="fs" type="button" onClick={() => void document.documentElement.requestFullscreen()}>
          Full screen
        </button>
      )}
      <div className="frame">
        {view.data && <ProjectorView view={view.data} origin={window.location.origin} />}
        {view.error && (
          <div className="proj blank gone" role="alert">
            <div>
              <h1>{gone ? "This projector link no longer works." : "The projector can’t reach Class Connect."}</h1>
              <p>
                {gone
                  ? "Open the new link from the Course desk."
                  : "Check the connection; this page keeps trying."}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
