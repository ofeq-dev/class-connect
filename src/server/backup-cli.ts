import { parseArgs } from "node:util";
import { backupDatabase, DEFAULT_BACKUP_DIR, type BackupKind } from "./backup";

// Built to dist/server/backup.js. Run by the nightly timer and by the deploy script:
//   node dist/server/backup.js --kind nightly|pre-deploy [--label <sha>]
// DATABASE_PATH names the database, BACKUP_DIR the folder (default /mnt/d/class-connect-backups).

const { values } = parseArgs({
  options: { kind: { type: "string", default: "nightly" }, label: { type: "string" } },
});

if (values.kind !== "nightly" && values.kind !== "pre-deploy") {
  console.error(`--kind must be nightly or pre-deploy, not ${values.kind}`);
  process.exit(2);
}

const result = await backupDatabase({
  databasePath: process.env.DATABASE_PATH ?? "./class-connect.db",
  backupDir: process.env.BACKUP_DIR ?? DEFAULT_BACKUP_DIR,
  kind: values.kind as BackupKind,
  label: values.label,
});

if (result.status === "skipped") {
  console.log(`Backup skipped: ${result.reason}`);
} else {
  console.log(`Backup written: ${result.file}`);
  for (const name of result.pruned) console.log(`Pruned: ${name}`);
}
