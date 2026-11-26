import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export type Db = BetterSQLite3Database;

export interface OpenedDatabase {
  db: Db;
  sqlite: Database.Database;
  /** Tag of the newest applied migration, e.g. "0000_lecturer_and_course". */
  migrationVersion(): string;
  close(): void;
}

/**
 * Opens the database and applies the checked-in migrations before anything else runs.
 * The app and the tests share this path. Pass ":memory:" for a fresh test database.
 */
export function openDatabase(file: string, migrationsDir: string): OpenedDatabase {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: migrationsDir });

  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsDir, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };

  return {
    db,
    sqlite,
    migrationVersion() {
      const { count } = sqlite
        .prepare("select count(*) as count from __drizzle_migrations")
        .get() as { count: number };
      return journal.entries[count - 1]?.tag ?? "none";
    },
    close: () => sqlite.close(),
  };
}
