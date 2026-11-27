import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** LLM requests sent per day (UTC, as OpenRouter's free limit resets), against the 1000/day limit. */
export const llmUsage = sqliteTable("llm_usage", {
  day: text("day").primaryKey(),
  requests: integer("requests").notNull().default(0),
});
