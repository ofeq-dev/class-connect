import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { validator } from "hono/validator";
import type { ProjectorMode, SessionChanges } from "../course";
import { NotFoundError } from "../errors";
import { verifyPassword } from "../lecturer-auth";
import { streamLiveEvents } from "../live-events";
import type { Level } from "../homework";
import { DAILY_LIMIT } from "../llm";
import type { AppDeps } from "./app";
import { projectorView } from "./projector";

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

/** The Diagnostics flag on attendance routes: ?diagnostics=1 adds IPs, blocks and device IDs. */
const diagnosticsFlag = validator("query", (q) => ({ diagnostics: q.diagnostics === "1" ? ("1" as const) : undefined }));

const reviewBody = (b: Body) => ({
  levels: (Array.isArray(b.levels) ? b.levels : []).map((l) => {
    const o = (l && typeof l === "object" ? l : {}) as Body;
    return {
      criterionId: Number(o.criterionId),
      level: str(o.level) as Level,
      evidence: str(o.evidence),
      feedback: str(o.feedback),
    };
  }),
});

const sessionTimes = (b: Body) => ({ date: str(b.date), start: str(b.start), end: str(b.end) });

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * A Content-Disposition for a download: the name as typed (any script) in filename*, and a
 * plain-ASCII fallback for old clients. Characters file systems refuse are dropped from both.
 */
function attachment(fileName: string) {
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const name = clean(fileName.replace(/[\\/:*?"<>|\p{Cc}]/gu, ""));
  const ascii = clean(name.replace(/[^\x20-\x7e]/g, ""));
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function idParam(c: Context, name: string): number {
  const id = Number(c.req.param(name));
  if (!Number.isInteger(id) || id <= 0) throw new NotFoundError(name);
  return id;
}

export function lecturerRoutes(deps: AppDeps) {
  /** The console's Attendance glance; Diagnostics (?diagnostics=1) adds IPs, blocks and device IDs. */
  const glance = (c: Context, sessionId: number) =>
    deps.attendance.forLecturer(sessionId, { diagnostics: c.req.query("diagnostics") === "1" });

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

    // The Projector window: its link, and what the class sees (the console's thumbnail).
    .get("/courses/:courseId/projector", requireLecturer, (c) => {
      const course = ownCourse(c);
      return c.json({ secret: deps.course.projectorSecret(course.id), view: projectorView(deps, course) });
    })
    .post("/courses/:courseId/projector/new-link", requireLecturer, (c) => {
      const course = ownCourse(c);
      return c.json({ secret: deps.course.newProjectorLink(course.id), view: projectorView(deps, course) });
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
      json((b): SessionChanges => ({
        date: optStr(b.date),
        start: optStr(b.start),
        end: optStr(b.end),
        // The module refuses a mode it doesn't know.
        projectorMode: optStr(b.projectorMode) as ProjectorMode | undefined,
      })),
      (c) => c.json(deps.course.updateSession(ownSession(c).id, c.req.valid("json"))),
    )
    .delete("/courses/:courseId/sessions/:sessionId", requireLecturer, (c) => {
      const { id } = ownSession(c);
      deps.summaries.deleteSummary(id);
      deps.course.deleteSession(id);
      return c.json({ ok: true });
    })

    // The Attendance sheet (FR-ATT-14), as a file to save.
    .get("/courses/:courseId/attendance.xlsx", requireLecturer, async (c) => {
      const course = ownCourse(c);
      const bytes = await deps.attendance.exportXlsx(course.id);
      return c.body(bytes, 200, {
        "content-type": XLSX,
        "content-disposition": attachment(`${course.name} attendance ${deps.course.today()}.xlsx`),
      });
    })

    // Attendance: the Check-in window, the live count, Network approval and Manual marks.
    // Every route answers with the console's glance; IPs only with ?diagnostics=1 (FR-LC-6).
    .get("/courses/:courseId/sessions/:sessionId/attendance", requireLecturer, diagnosticsFlag, (c) =>
      c.json(glance(c, ownSession(c).id)),
    )
    .post(
      "/courses/:courseId/sessions/:sessionId/attendance/window/open",
      requireLecturer, diagnosticsFlag,
      json((b) => ({ ipv4: optStr(b.ipv4) ?? null, ipv6: optStr(b.ipv6) ?? null })),
      (c) => {
        const sessionId = ownSession(c).id;
        deps.attendance.openWindow(sessionId, c.req.valid("json"));
        return c.json(glance(c, sessionId));
      },
    )
    .post("/courses/:courseId/sessions/:sessionId/attendance/window/close", requireLecturer, diagnosticsFlag, (c) => {
      const sessionId = ownSession(c).id;
      deps.attendance.closeWindow(sessionId);
      return c.json(glance(c, sessionId));
    })
    .post("/courses/:courseId/sessions/:sessionId/attendance/networks/:key/approve", requireLecturer, diagnosticsFlag, (c) => {
      const sessionId = ownSession(c).id;
      // The console names a network by its card's opaque key; the block is looked up here.
      const card = deps.attendance
        .forLecturer(sessionId, { diagnostics: true })
        .networks.find((n) => n.key === c.req.param("key"));
      if (!card?.block) throw new NotFoundError("Network");
      deps.attendance.approveNetwork(sessionId, card.block);
      return c.json(glance(c, sessionId));
    })
    .post(
      "/courses/:courseId/sessions/:sessionId/attendance/marks/:rosterEntryId",
      requireLecturer, diagnosticsFlag,
      json((b) => ({ present: typeof b.present === "boolean" ? b.present : null })),
      (c) => {
        const sessionId = ownSession(c).id;
        deps.attendance.mark(sessionId, idParam(c, "rosterEntryId"), c.req.valid("json").present);
        return c.json(glance(c, sessionId));
      },
    )

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
    .post("/courses/:courseId/assignments/:assignmentId/review-run", requireLecturer, (c) =>
      c.json(deps.homework.startReviewRun(ownAssignment(c).id)),
    )
    .post("/courses/:courseId/assignments/:assignmentId/submissions/:submissionId/review/retry", requireLecturer, (c) =>
      c.json(deps.homework.retryReview(ownAssignment(c).id, idParam(c, "submissionId"))),
    )
    .put(
      "/courses/:courseId/assignments/:assignmentId/submissions/:submissionId/review",
      requireLecturer,
      json(reviewBody),
      (c) =>
        c.json(
          deps.homework.editReview(ownAssignment(c).id, idParam(c, "submissionId"), c.req.valid("json").levels),
        ),
    )

    .get("/llm-usage", requireLecturer, (c) => c.json({ today: deps.llm.usageToday(), limit: DAILY_LIMIT }))

    .get("/events", requireLecturer, (c) => {
      const course = c.req.query("course");
      const courseId = course ? deps.course.readCourse(c.var.lecturerId, Number(course)).id : null;
      return streamLiveEvents(c, deps.events, { courseId, role: "lecturer" }, deps.sseHeartbeatMs);
    });
}
