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
    /** The pinned structured-output model for Reviews, tried before the fallback list. */
    reviewModel: string;
    /** The free embedding model for homework similarity. */
    embeddingModel: string;
    fakeDelayMs: number;
  };
}

/** The free-model fallback list (#4). Overridable with LLM_MODELS, comma-separated. */
export const DEFAULT_LLM_MODELS = [
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/free",
];

/** The pinned structured-output model for Reviews (#4, #20). Overridable with LLM_REVIEW_MODEL. */
export const DEFAULT_REVIEW_MODEL = "nvidia/nemotron-3.5-super-vl:free";

/** The free embedding model (#10). Overridable with LLM_EMBEDDING_MODEL. */
export const DEFAULT_EMBEDDING_MODEL = "nvidia/nemotron-3.5-embed-1b:free";

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
      reviewModel: env.LLM_REVIEW_MODEL || DEFAULT_REVIEW_MODEL,
      embeddingModel: env.LLM_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
      fakeDelayMs: Number(env.FAKE_LLM_DELAY_MS ?? 1500),
    },
  };
}
