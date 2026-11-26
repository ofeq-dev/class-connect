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
  /** Where uploads are kept under their content hash. */
  filesDir: string;
  llm: {
    adapter: "openrouter" | "fake";
    /** Empty until the key is installed; summaries then fail with a retryable error. */
    openRouterApiKey: string;
    /** The fallback list for summaries and translations, in order. */
    models: string[];
    fakeDelayMs: number;
  };
}

/** The free-model fallback list (#4). Overridable with LLM_MODELS, comma-separated. */
export const DEFAULT_LLM_MODELS = [
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/free",
];

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
    filesDir: env.FILES_DIR ?? "./files",
    llm: {
      adapter: env.LLM_ADAPTER === "fake" ? "fake" : "openrouter",
      openRouterApiKey: env.OPENROUTER_API_KEY ?? "",
      models: env.LLM_MODELS ? env.LLM_MODELS.split(",").map((m) => m.trim()).filter(Boolean) : DEFAULT_LLM_MODELS,
      fakeDelayMs: Number(env.FAKE_LLM_DELAY_MS ?? 1500),
    },
  };
}
