import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { AttendanceModule } from "../attendance";
import type { CourseModule } from "../course";
import { DomainError, NotFoundError } from "../errors";
import type { HomeworkModule } from "../homework";
import type { LiveEvents } from "../live-events";
import type { LlmGateway } from "../llm";
import type { SummariesModule } from "../summaries";
import { lecturerRoutes } from "./lecturer";
import { projectorRoutes } from "./projector";
import { studentRoutes } from "./student";

export interface AppDeps {
  course: CourseModule;
  attendance: AttendanceModule;
  summaries: SummariesModule;
  homework: HomeworkModule;
  llm: Pick<LlmGateway, "usageToday">;
  events: LiveEvents;
  lecturer: { id: number; passwordHash: string };
  cookieSecret: string;
  sseHeartbeatMs: number;
  health: () => { sha: string; migration: string };
  /** Built front end to serve, when present (production). */
  clientDir?: string;
}

/** Routes are thin adapters: they resolve the caller and call module interfaces, nothing more. */
export function createApp(deps: AppDeps) {
  const app = new Hono()
    .onError((err, c) => {
      if (err instanceof DomainError) return c.json({ error: err.code, message: err.message }, 400);
      if (err instanceof NotFoundError) return c.json({ error: "not-found", message: err.message }, 404);
      console.error(err);
      return c.json({ error: "internal", message: "Something went wrong." }, 500);
    })
    .get("/healthz", (c) => c.json(deps.health()))
    .route("/api/lecturer", lecturerRoutes(deps))
    .route("/api/student", studentRoutes(deps))
    .route("/api/projector", projectorRoutes(deps));

  if (deps.clientDir && fs.existsSync(deps.clientDir)) {
    const root = path.relative(process.cwd(), deps.clientDir);
    const indexHtml = fs.readFileSync(path.join(deps.clientDir, "index.html"), "utf8");
    app.use("/*", serveStatic({ root }));
    app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(indexHtml)));
  }

  return app;
}

export type AppType = ReturnType<typeof createApp>;
