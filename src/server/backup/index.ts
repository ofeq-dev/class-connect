import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Consistent copies of the SQLite database, made by the app itself with better-sqlite3's
 * online backup, which is safe while the app is writing in WAL mode (#19, ADR 0003).
 * Copies are named `<kind>-<UTC timestamp>[-<label>].db`, so names sort by age within a kind.
 */

export type BackupKind = "nightly" | "pre-deploy";

/** How many copies of each kind are kept (#19): 14 nightly, the last 5 pre-deploy. */
export const BACKUPS_KEPT: Record<BackupKind, number> = { nightly: 14, "pre-deploy": 5 };

export const DEFAULT_BACKUP_DIR = "/mnt/d/class-connect-backups";

export interface BackupOptions {
  databasePath: string;
  backupDir: string;
  kind: BackupKind;
  /** Extra name part, e.g. the commit SHA being deployed. */
  label?: string;
  now?: Date;
}

export type BackupResult =
  | { status: "written"; file: string; pruned: string[] }
  | { status: "skipped"; reason: string };

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Copies the database into the backup folder, then prunes that kind down to its quota. */
export async function backupDatabase(options: BackupOptions): Promise<BackupResult> {
  const { databasePath, backupDir, kind, label, now = new Date() } = options;
  if (!fs.existsSync(databasePath)) {
    return { status: "skipped", reason: `no database at ${databasePath}` };
  }
  fs.mkdirSync(backupDir, { recursive: true });

  const safeLabel = label ? `-${label.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40)}` : "";
  const file = path.join(backupDir, `${kind}-${stamp(now)}${safeLabel}.db`);
  const partial = `${file}.partial`;

  // Opened without migrating: a backup must copy the schema as it is.
  const source = new Database(databasePath, { fileMustExist: true });
  try {
    await source.backup(partial);
  } finally {
    source.close();
  }
  fs.renameSync(partial, file);

  return { status: "written", file, pruned: pruneBackups(backupDir, kind) };
}

/** Deletes the oldest copies of one kind beyond `keep`. Returns the deleted file names. */
export function pruneBackups(
  backupDir: string,
  kind: BackupKind,
  keep: number = BACKUPS_KEPT[kind],
): string[] {
  const copies = fs
    .readdirSync(backupDir)
    .filter((name) => name.startsWith(`${kind}-`) && name.endsWith(".db"))
    .sort()
    .reverse();
  const doomed = copies.slice(keep);
  for (const name of doomed) fs.rmSync(path.join(backupDir, name));
  return doomed;
}
