import path from "node:path";
import { DEFAULT_TIME_ZONE } from "./clock";

export interface Config {
  port: number;
  databasePath: string;
  migrationsDir: string;
  lecturerName: string;
  lecturerPasswordHash: string;
  cookieSecret: string;
  sseHeartbeatMs: number;
  commitSha: string;
  timeZone: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? "./class-connect.db",
    migrationsDir: env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "drizzle"),
    lecturerName: env.LECTURER_NAME ?? "Lecturer",
    lecturerPasswordHash: required(env, "LECTURER_PASSWORD_HASH"),
    cookieSecret: required(env, "COOKIE_SECRET"),
    sseHeartbeatMs: Number(env.SSE_HEARTBEAT_MS ?? 25_000),
    commitSha: env.GIT_SHA ?? "unknown",
    timeZone: env.APP_TIME_ZONE ?? DEFAULT_TIME_ZONE,
  };
}
