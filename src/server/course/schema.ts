import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const lecturer = sqliteTable("lecturer", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
});

export const course = sqliteTable("course", {
  id: integer("id").primaryKey(),
  lecturerId: integer("lecturer_id")
    .notNull()
    .references(() => lecturer.id),
  name: text("name").notNull(),
  /** JSON array of language codes for Session summary translations, e.g. ["ar","ru"]. */
  translationLanguages: text("translation_languages").notNull().default("[]"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});
