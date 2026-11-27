import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { validator } from "hono/validator";
import { NotFoundError } from "../errors";
import { verifyPassword } from "../lecturer-auth";
import { streamLiveEvents } from "../live-events";
import { DAILY_LIMIT } from "../llm";
import type { AppDeps } from "./app";

export const LECTURER_COOKIE = "cc_lecturer";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const optStr = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * Narrows a JSON body to the shape a route takes. Only shapes are checked here; the module
 * applies the rules. Declaring it also types the request body for Hono's typed client.
 */
const json = <T>(shape: (b: Body) => T) =>
  validator("json", (value) => shape(value && typeof value === "object" ? (value as Body) : {}));

const assignmentBody = (b: Body) => ({
  title: str(b.title),
  instructions: str(b.instructions),
  dueAt: str(b.dueAt),
  criteria: Array.isArray(b.criteria) ? b.criteria.map(str) : [],
});

const sessionTimes = (b: Body) => ({ date: str(b.date), start: str(b.start), end: str(b.end) });

function idParam(c: Context, name: string): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError(name);
  return id;
}

export function lecturerRoutes(deps: AppDeps) {
  const requireLecturer = createMiddleware<{ Variables: { lecturerId: number } }>(
    async (c, next) => {
      const value = await getSignedCookie(c, deps.cookieSecret, LECTURER_COOKIE);
      if (!value || Number(value) !== deps.lecturer.id) {
        return c.json({ error: "unauthenticated", message: "Sign in first." }, 401);
      }
      c.set("lecturerId", deps.lecturer.id);
      await next();
    },
  );

  /** Resolves :courseId to a Course owned by the signed-in Lecturer, else 404. */
  const ownCourse = (c: Context<{ Variables: { lecturerId: number } }>) =>
    deps.course.readCourse(c.var.lecturerId, idParam(c, "courseId"));

  /** Resolves :sessionId to a Session of the Lecturer's :courseId, else 404. */
  const ownSession = (c: Context<{ Variables: { lecturerId: number } }>) => {
    const course = ownCourse(c);
    const session = deps.course.readSession(idParam(c, "sessionId"));
    if (session.courseId !== course.id) throw new NotFoundError("Session");
    return session;
  };

  /** Resolves :assignmentId to an Assignment of the Lecturer's :courseId, else 404. */
  const ownAssignment = (c: Context<{ Variables: { lecturerId: number } }>) => {
    const course = ownCourse(c);
    const assignment = deps.homework.lecturerView(idParam(c, "assignmentId"));
    if (assignment.courseId !== course.id) throw new NotFoundError("Assignment");
    return assignment;
  };

  return new Hono<{ Variables: { lecturerId: number } }>()
    .post("/session", json((b) => ({ password: str(b.password) })), async (c) => {
      const { password } = c.req.valid("json");
      if (!verifyPassword(password, deps.lecturer.passwordHash)) {
        return c.json({ error: "wrong-password", message: "That password isn't right." }, 401);
      }
      await setSignedCookie(c, LECTURER_COOKIE, String(deps.lecturer.id), deps.cookieSecret, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: THIRTY_DAYS,
      });
      return c.json({ ok: true });
    })
    .delete("/session", (c) => {
      deleteCookie(c, LECTURER_COOKIE, { path: "/", secure: true });
      return c.json({ ok: true });
    })
    .get("/me", requireLecturer, (c) => c.json({ id: c.var.lecturerId }))

    // Courses
    .get("/courses", requireLecturer, (c) => c.json(deps.course.listCourses(c.var.lecturerId)))
    .post("/courses", requireLecturer, json((b) => ({ name: str(b.name) })), (c) => {
      const created = deps.course.createCourse(c.var.lecturerId, c.req.valid("json").name);
      return c.json(created, 201);
    })
    .get("/courses/:courseId", requireLecturer, (c) => c.json(ownCourse(c)))
    .patch(
      "/courses/:courseId",
      requireLecturer,
      json((b) => ({
        name: optStr(b.name),
        translationLanguages: Array.isArray(b.translationLanguages) ? b.translationLanguages.map(str) : undefined,
      })),
      (c) => c.json(deps.course.updateCourse(ownCourse(c).id, c.req.valid("json"))),
    )

    // Roster
    .get("/courses/:courseId/roster", requireLecturer, (c) =>
      c.json(deps.course.listRoster(ownCourse(c).id)),
    )
    .post(
      "/courses/:courseId/roster",
      requireLecturer,
      json((b) => ({ studentId: str(b.studentId), name: str(b.name) })),
      (c) => {
        const { studentId, name } = c.req.valid("json");
        return c.json(deps.course.addRosterEntry(ownCourse(c).id, studentId, name), 201);
      },
    )
    .post("/courses/:courseId/roster/import", requireLecturer, json((b) => ({ csv: str(b.csv) })), (c) =>
      c.json(deps.course.importRoster(ownCourse(c).id, c.req.valid("json").csv)),
    )
    .post("/courses/:courseId/roster/:entryId/reset-claim", requireLecturer, (c) => {
      const course = ownCourse(c);
      return c.json(deps.course.resetClaim(course.id, idParam(c, "entryId")));
    })

    // Sessions
    .get("/courses/:courseId/sessions", requireLecturer, (c) => {
      const course = ownCourse(c);
      return c.json({ today: deps.course.today(), sessions: deps.course.listSessions(course.id) });
    })
    .post("/courses/:courseId/sessions", requireLecturer, json(sessionTimes), (c) =>
      c.json(deps.course.createSession(ownCourse(c).id, c.req.valid("json")), 201),
    )
    .get("/courses/:courseId/sessions/:sessionId", requireLecturer, (c) => c.json(ownSession(c)))
    .patch(
      "/courses/:courseId/sessions/:sessionId",
      requireLecturer,
      json((b) => ({ date: optStr(b.date), start: optStr(b.start), end: optStr(b.end) })),
      (c) => c.json(deps.course.updateSession(ownSession(c).id, c.req.valid("json"))),
    )
    .delete("/courses/:courseId/sessions/:sessionId", requireLecturer, (c) => {
      const { id } = ownSession(c);
      deps.summaries.deleteSummary(id);
      deps.course.deleteSession(id);
      return c.json({ ok: true });
    })

    // Attendance: the Check-in window and the live count
    .get("/courses/:courseId/sessions/:sessionId/attendance", requireLecturer, (c) =>
      c.json(deps.attendance.forLecturer(ownSession(c).id)),
    )
    .post(
      "/courses/:courseId/sessions/:sessionId/attendance/window/open",
      requireLecturer,
      json((b) => ({ ipv4: optStr(b.ipv4) ?? null, ipv6: optStr(b.ipv6) ?? null })),
      (c) => {
        const sessionId = ownSession(c).id;
        deps.attendance.openWindow(sessionId, c.req.valid("json"));
        return c.json(deps.attendance.forLecturer(sessionId));
      },
    )
    .post("/courses/:courseId/sessions/:sessionId/attendance/window/close", requireLecturer, (c) => {
      const sessionId = ownSession(c).id;
      deps.attendance.closeWindow(sessionId);
      return c.json(deps.attendance.forLecturer(sessionId));
    })

    // Session summaries
    .get("/courses/:courseId/summaries", requireLecturer, (c) =>
      c.json(deps.summaries.forCourse(ownCourse(c).id)),
    )
    .get("/courses/:courseId/sessions/:sessionId/summary", requireLecturer, (c) =>
      c.json(deps.summaries.forLecturer(ownSession(c).id)),
    )
    .post(
      "/courses/:courseId/sessions/:sessionId/summary/transcript",
      requireLecturer,
      json((b) => ({ text: str(b.text), fileName: optStr(b.fileName) })),
      async (c) => c.json(await deps.summaries.uploadTranscript(ownSession(c).id, c.req.valid("json"))),
    )
    .post("/courses/:courseId/sessions/:sessionId/summary/generate", requireLecturer, (c) =>
      c.json(deps.summaries.generate(ownSession(c).id)),
    )
    .post("/courses/:courseId/sessions/:sessionId/summary/retry", requireLecturer, (c) =>
      c.json(deps.summaries.retry(ownSession(c).id)),
    )
    .post(
      "/courses/:courseId/sessions/:sessionId/summary/versions",
      requireLecturer,
      json((b) => ({ markdown: str(b.markdown) })),
      (c) => c.json(deps.summaries.saveEdit(ownSession(c).id, c.req.valid("json").markdown)),
    )
    .post("/courses/:courseId/sessions/:sessionId/summary/versions/:versionId/restore", requireLecturer, (c) =>
      c.json(deps.summaries.restore(ownSession(c).id, idParam(c, "versionId"))),
    )
    .post("/courses/:courseId/sessions/:sessionId/summary/versions/:versionId/publish", requireLecturer, (c) =>
      c.json(deps.summaries.publish(ownSession(c).id, idParam(c, "versionId"))),
    )
    .put(
      "/courses/:courseId/sessions/:sessionId/summary/translations/:language",
      requireLecturer,
      json((b) => ({ markdown: str(b.markdown) })),
      (c) =>
        c.json(
          deps.summaries.saveTranslation(ownSession(c).id, c.req.param("language"), c.req.valid("json").markdown),
        ),
    )
    .post("/courses/:courseId/sessions/:sessionId/summary/translations/:language/retry", requireLecturer, (c) =>
      c.json(deps.summaries.retryTranslation(ownSession(c).id, c.req.param("language"))),
    )

    // Assignments
    .get("/courses/:courseId/assignments", requireLecturer, (c) =>
      c.json(deps.homework.forCourse(ownCourse(c).id)),
    )
    .post("/courses/:courseId/assignments", requireLecturer, json(assignmentBody), (c) =>
      c.json(deps.homework.setAssignment(ownCourse(c).id, c.req.valid("json")), 201),
    )
    .post(
      "/courses/:courseId/assignments/draft-criteria",
      requireLecturer,
      json((b) => ({ title: str(b.title), instructions: str(b.instructions) })),
      async (c) => {
        ownCourse(c);
        return c.json({ criteria: await deps.homework.draftCriteria(c.req.valid("json")) });
      },
    )
    .get("/courses/:courseId/assignments/:assignmentId", requireLecturer, (c) => c.json(ownAssignment(c)))
    .put("/courses/:courseId/assignments/:assignmentId", requireLecturer, json(assignmentBody), (c) => {
      const { courseId, id } = ownAssignment(c);
      return c.json(deps.homework.setAssignment(courseId, c.req.valid("json"), id));
    })

    .get("/llm-usage", requireLecturer, (c) => c.json({ today: deps.llm.usageToday(), limit: DAILY_LIMIT }))

    .get("/events", requireLecturer, (c) => {
      const course = c.req.query("course");
      const courseId = course ? deps.course.readCourse(c.var.lecturerId, Number(course)).id : null;
      return streamLiveEvents(c, deps.events, { courseId, role: "lecturer" }, deps.sseHeartbeatMs);
    });
}
