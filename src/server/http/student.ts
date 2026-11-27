import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { validator } from "hono/validator";
import type { RosterEntry, Session, Viewer } from "../course";
import { DomainError, NotFoundError } from "../errors";
import { streamLiveEvents } from "../live-events";
import type { AppDeps } from "./app";

export const DEVICE_COOKIE = "cc_device";
/** The longest lifetime browsers allow; refreshed on every visit (ADR 0002). */
const FOUR_HUNDRED_DAYS = 400 * 24 * 60 * 60;

type Vars = { Variables: { deviceToken: string | undefined } };

/** `?lang=` on a summary read: the language wanted, "" or absent for the source. */
const langQuery = validator("query", (value) => ({
  lang: typeof value.lang === "string" ? value.lang : undefined,
}));

const studentIdBody = validator("json", (value) => {
  const b = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { studentId: typeof b.studentId === "string" ? b.studentId : "" };
});

function setDeviceCookie(c: Context, token: string) {
  setCookie(c, DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: FOUR_HUNDRED_DAYS,
  });
}

/** What the Student app may know about its own Roster entry: never the device token. */
const me = (entry: RosterEntry) => ({ name: entry.name, studentId: entry.studentId });

/**
 * The phone's public IP. Behind the Cloudflare Tunnel (the only way in, ADR 0003) that is
 * CF-Connecting-IP; without it (local development) the socket's own address.
 */
function clientIp(c: Context): string {
  const header = c.req.header("cf-connecting-ip")?.trim();
  if (header) return header;
  try {
    return getConnInfo(c).remote.address ?? "";
  } catch {
    return "";
  }
}

export function studentRoutes(deps: AppDeps) {
  /**
   * Loading the QR page is the Check-in (ADR 0001): no tap. A closed window isn't an error for
   * the page; the Student's own line says so.
   */
  function checkInOnScan(c: Context, session: Session, entry: RosterEntry, token: string) {
    try {
      deps.attendance.checkIn(session.id, entry.id, clientIp(c), token);
    } catch (err) {
      if (!(err instanceof DomainError && err.code === "check-in.closed")) throw err;
    }
    return deps.attendance.forStudent(session.id, entry.id);
  }

  /**
   * Reads the device token and, when it still resolves to a Student, refreshes the cookie so a
   * phone in use is never forgotten. An unknown or reset token is left alone: it's unclaimed.
   */
  const deviceToken = createMiddleware<Vars>(async (c, next) => {
    const token = getCookie(c, DEVICE_COOKIE);
    c.set("deviceToken", token);
    await next();
    const alreadySet = c.res.headers.getSetCookie().some((h) => h.startsWith(`${DEVICE_COOKIE}=`));
    if (token && !alreadySet && deps.course.whoIs(token)) setDeviceCookie(c, token);
  });

  /** The Student this phone is, or a 401 the route returns. */
  const student = (c: Context<Vars>) => deps.course.whoIs(c.var.deviceToken);
  const unclaimed = (c: Context) =>
    c.json({ error: "unclaimed", message: "Scan your Session's QR code first." }, 401);
  const assignmentParam = (c: Context) => {
    const id = Number(c.req.param("assignmentId"));
    if (!Number.isInteger(id) || id <= 0) throw new NotFoundError("Assignment");
    return id;
  };

  const qrSession = (c: Context) => deps.course.readSession(c.req.param("code") ?? "");

  return new Hono<Vars>()
    .use(deviceToken)

    // The QR entry page, /s/<code>: a claimed phone is checked in by loading it; a new one claims first.
    .get("/s/:code", (c) => {
      const session = qrSession(c);
      const token = c.var.deviceToken;
      const viewer = deps.course.whoIs(token, session.courseId);
      const course = deps.course.courseSummary(session.courseId);
      if (!viewer || !token) return c.json({ course, session, me: null, checkIn: null });
      const checkIn = checkInOnScan(c, session, viewer.rosterEntry, token);
      return c.json({ course, session, me: me(viewer.rosterEntry), checkIn });
    })
    .post("/s/:code/lookup", studentIdBody, (c) => {
      const session = qrSession(c);
      const entry = deps.course.findRosterEntry(session.courseId, c.req.valid("json").studentId);
      if (!entry) {
        throw new DomainError("claim.unknown-student", "That student ID isn't on this Course's Roster.");
      }
      const mine = deps.course.whoIs(c.var.deviceToken, session.courseId)?.rosterEntry.id === entry.id;
      if (entry.claimed && !mine) {
        throw new DomainError("claim.already-claimed", "Already claimed — ask your Lecturer.");
      }
      return c.json({ name: entry.name });
    })
    .post("/s/:code/claim", studentIdBody, (c) => {
      const session = qrSession(c);
      // One token per phone: a phone already bound on another Course keeps its token.
      const token = c.var.deviceToken ?? randomBytes(32).toString("base64url");
      const entry = deps.course.claim(session.courseId, c.req.valid("json").studentId, token);
      setDeviceCookie(c, token);
      // The first scan does everything: claim, then Check-in.
      return c.json({ ...me(entry), checkIn: checkInOnScan(c, session, entry, token) });
    })

    // The Student app at /.
    .get("/me", (c) => {
      const viewer: Viewer | null = deps.course.whoIs(c.var.deviceToken);
      if (!viewer) return c.json({ claimed: false as const });
      const today = deps.course.today();
      const session = deps.course.listSessions(viewer.course.id).find((s) => s.date === today) ?? null;
      return c.json({
        claimed: true as const,
        course: { id: viewer.course.id, name: viewer.course.name },
        me: me(viewer.rosterEntry),
        today,
        session,
        checkIn: session ? deps.attendance.forStudent(session.id, viewer.rosterEntry.id) : null,
      });
    })

    // Assignments
    .get("/assignments", (c) => {
      const viewer = student(c);
      if (!viewer) return unclaimed(c);
      return c.json(deps.homework.forStudent(viewer.course.id, viewer.rosterEntry.id));
    })
    .get("/assignments/:assignmentId", (c) => {
      const viewer = student(c);
      if (!viewer) return unclaimed(c);
      return c.json(deps.homework.studentView(assignmentParam(c), viewer.rosterEntry.id));
    })
    .post(
      "/assignments/:assignmentId/submission",
      validator("json", (value) => {
        const b = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        return {
          text: typeof b.text === "string" ? b.text : undefined,
          pdfBase64: typeof b.pdfBase64 === "string" ? b.pdfBase64 : undefined,
          fileName: typeof b.fileName === "string" ? b.fileName : "",
        };
      }),
      async (c) => {
        const viewer = student(c);
        if (!viewer) return unclaimed(c);
        const { text, pdfBase64, fileName } = c.req.valid("json");
        const input =
          pdfBase64 !== undefined
            ? { pdf: new Uint8Array(Buffer.from(pdfBase64, "base64")), fileName }
            : { text: text ?? "" };
        return c.json(await deps.homework.submit(assignmentParam(c), viewer.rosterEntry.id, input));
      },
    )

    // Topics to comment on, Comments, and the Student's own (Mine)
    .get("/topics", (c) => {
      const viewer = student(c);
      if (!viewer) return unclaimed(c);
      return c.json(deps.feedback.listTopics(viewer.course.id));
    })
    .post(
      "/comments",
      validator("json", (value) => {
        const b = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        return {
          topicId: typeof b.topicId === "number" ? b.topicId : 0,
          text: typeof b.text === "string" ? b.text : undefined,
          reaction: typeof b.reaction === "string" ? b.reaction : undefined,
          anonymous: b.anonymous === true,
        };
      }),
      (c) => {
        const { topicId, ...input } = c.req.valid("json");
        return c.json(deps.feedback.comment(c.var.deviceToken, topicId, input), 201);
      },
    )
    .get("/comments", (c) => c.json(deps.feedback.mine(c.var.deviceToken)))
    .delete("/comments/:commentId", (c) => {
      const id = Number(c.req.param("commentId"));
      if (!Number.isInteger(id) || id <= 0) throw new NotFoundError("Comment");
      deps.feedback.deleteComment(c.var.deviceToken, id);
      return c.json({ ok: true });
    })

    // Published Session summaries of this phone's Course, and one to read.
    .get("/summaries", (c) => c.json(deps.summaries.listForStudent(c.var.deviceToken)))
    .get("/summaries/:sessionId", langQuery, (c) => {
      const published = deps.summaries.forStudent(
        c.var.deviceToken,
        Number(c.req.param("sessionId")),
        c.req.valid("query").lang,
      );
      if (!published) throw new NotFoundError("Session summary");
      return c.json(published);
    })

    .get("/events", (c) => {
      const viewer = deps.course.whoIs(c.var.deviceToken);
      if (!viewer) return c.json({ error: "unclaimed", message: "Scan your Session's QR code first." }, 401);
      return streamLiveEvents(c, deps.events, { courseId: viewer.course.id, role: "student" }, deps.sseHeartbeatMs);
    });
}
