import { Hono } from "hono";
import type { WindowState } from "../attendance";
import type { Course } from "../course";
import { NotFoundError } from "../errors";
import type { ProjectorPoll } from "../feedback";
import { streamLiveEvents } from "../live-events";
import type { AppDeps } from "./app";

/**
 * What the Projector window shows, and everything it may know: the Course name, and in QR mode the
 * Session's times, its QR code and the checked-in count; in Poll mode the Poll's question, options
 * and vote count, with totals once it closes. Never a name, a Pending Check-in, a Comment or a voter.
 */
export type ProjectorView =
  | { courseName: string; mode: "blank"; sessionId: number | null }
  | { courseName: string; mode: "poll"; sessionId: number; poll: ProjectorPoll }
  | {
      courseName: string;
      mode: "qr";
      sessionId: number;
      session: { date: string; start: string; end: string; qrCode: string };
      window: WindowState;
      checkedIn: number;
    };

export function projectorView(deps: Pick<AppDeps, "course" | "attendance" | "feedback">, course: Course): ProjectorView {
  const projection = deps.course.projection(course.id);
  if (projection.mode === "blank") {
    return { courseName: course.name, mode: "blank", sessionId: projection.session?.id ?? null };
  }
  if (projection.mode === "poll") {
    const poll = deps.feedback.results(course.id, projection.pollId, "projector");
    return { courseName: course.name, mode: "poll", sessionId: projection.session.id, poll };
  }
  const { id, date, start, end, qrCode } = projection.session;
  const attendance = deps.attendance.forLecturer(id);
  return {
    courseName: course.name,
    mode: "qr",
    sessionId: id,
    session: { date, start, end, qrCode },
    window: attendance.window.state,
    checkedIn: attendance.present,
  };
}

/** The public Projector window, /p/<secret>: no sign-in; the unguessable link is the access (FR-LC-7). */
export function projectorRoutes(deps: AppDeps) {
  const linkedCourse = (secret: string | undefined) => {
    const course = deps.course.projectorCourse(secret ?? "");
    if (!course) throw new NotFoundError("Projector link");
    return course;
  };

  return new Hono()
    .get("/:secret", (c) => c.json(projectorView(deps, linkedCourse(c.req.param("secret")))))
    .get("/:secret/events", (c) => {
      const course = linkedCourse(c.req.param("secret"));
      return streamLiveEvents(c, deps.events, { courseId: course.id, role: "projector" }, deps.sseHeartbeatMs);
    });
}
