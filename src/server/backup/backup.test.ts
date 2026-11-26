import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupDatabase, pruneBackups } from ".";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-backup-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("backupDatabase", () => {
  it("makes a consistent copy of a WAL database, including rows not yet checkpointed", async () => {
    const dbPath = path.join(dir, "app.db");
    const live = new Database(dbPath);
    live.pragma("journal_mode = WAL");
    live.pragma("wal_autocheckpoint = 0"); // keep every write in the -wal file
    live.exec("create table note (id integer primary key, body text)");
    const insert = live.prepare("insert into note (body) values (?)");
    for (let i = 0; i < 100; i++) insert.run(`note ${i}`);
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    const result = await backupDatabase({
      databasePath: dbPath,
      backupDir: path.join(dir, "backups"),
      kind: "pre-deploy",
      label: "abc123",
      now: new Date("2026-11-26T03:00:00.000Z"),
    });
    live.close();

    expect(result).toMatchObject({ status: "written", pruned: [] });
    if (result.status !== "written") throw new Error("unreachable");
    expect(path.basename(result.file)).toBe("pre-deploy-20261126T030000Z-abc123.db");
    expect(fs.existsSync(`${result.file}.partial`)).toBe(false);

    const copy = new Database(result.file, { readonly: true });
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(copy.prepare("select count(*) as n from note").get()).toEqual({ n: 100 });
    copy.close();
  });

  it("skips when there is no database yet (first deploy)", async () => {
    const result = await backupDatabase({
      databasePath: path.join(dir, "missing.db"),
      backupDir: path.join(dir, "backups"),
      kind: "nightly",
    });
    expect(result.status).toBe("skipped");
    expect(fs.existsSync(path.join(dir, "backups"))).toBe(false);
  });

  it("prunes to the quota of its own kind after writing", async () => {
    const dbPath = path.join(dir, "app.db");
    new Database(dbPath).exec("create table t (x)");
    const backupDir = path.join(dir, "backups");
    for (let day = 1; day <= 16; day++) {
      await backupDatabase({
        databasePath: dbPath,
        backupDir,
        kind: "nightly",
        now: new Date(Date.UTC(2026, 10, day, 3)),
      });
    }
    await backupDatabase({ databasePath: dbPath, backupDir, kind: "pre-deploy", label: "x" });

    const names = fs.readdirSync(backupDir).sort();
    const nightly = names.filter((n) => n.startsWith("nightly-"));
    expect(nightly).toHaveLength(14);
    expect(nightly[0]).toBe("nightly-20261103T030000Z.db");
    expect(names.filter((n) => n.startsWith("pre-deploy-"))).toHaveLength(1);
  });
});

describe("pruneBackups", () => {
  it("keeps the newest copies of one kind and leaves other files alone", () => {
    const names = [
      ...Array.from({ length: 7 }, (_, i) => `pre-deploy-2026110${i + 1}T000000Z-sha${i}.db`),
      "nightly-20261101T030000Z.db",
      "notes.txt",
    ];
    for (const name of names) fs.writeFileSync(path.join(dir, name), "");

    const pruned = pruneBackups(dir, "pre-deploy");

    expect(pruned.sort()).toEqual([
      "pre-deploy-20261101T000000Z-sha0.db",
      "pre-deploy-20261102T000000Z-sha1.db",
    ]);
    expect(fs.readdirSync(dir)).toHaveLength(names.length - 2);
  });
});
