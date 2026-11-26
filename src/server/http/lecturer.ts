import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { verifyPassword } from "../lecturer-auth";
import { streamLiveEvents } from "../live-events";
import type { AppDeps } from "./app";

export const LECTURER_COOKIE = "cc_lecturer";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

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

  return new Hono()
    .post("/session", async (c) => {
      const body = await c.req.json<{ password?: unknown }>().catch(() => ({}) as { password?: unknown });
      const password = typeof body.password === "string" ? body.password : "";
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
    .get("/courses", requireLecturer, (c) => c.json(deps.course.listCourses(c.var.lecturerId)))
    .post("/courses", requireLecturer, async (c) => {
      const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
      const created = deps.course.createCourse(
        c.var.lecturerId,
        typeof body.name === "string" ? body.name : "",
      );
      return c.json(created, 201);
    })
    .get("/events", requireLecturer, (c) => {
      const course = c.req.query("course");
      const courseId = course ? Number(course) : null;
      return streamLiveEvents(c, deps.events, { courseId, role: "lecturer" }, deps.sseHeartbeatMs);
    });
}
