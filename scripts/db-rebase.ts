/**
 * Rebases this branch's migrations onto another branch's (default origin/dev).
 *
 * Parallel branches each take the next migration number, so merging the integration branch in
 * leaves two migrations with one number and a conflicted journal. Run this after `git merge`,
 * once the schema.ts files are merged. It keeps the base's migrations as they are, regenerates
 * this branch's as one new migration on top, and refuses if the regenerated SQL differs from
 * what the branch had (a hand-edited migration, or schema drift, needs a person to look).
 * Then it checks that a fresh database and a database on the base's migrations both migrate.
 *
 *   npm run db:rebase [-- <base-ref>]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/server/db";

const DIR = "drizzle";
const base = process.argv[2] ?? "origin/dev";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });
const sqlFiles = () => fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();

const baseFiles = new Set(git("ls-tree", "--name-only", `${base}:${DIR}`).split("\n").filter(Boolean));
const baseMeta = new Set(git("ls-tree", "--name-only", `${base}:${DIR}/meta`).split("\n").filter(Boolean));
const ours = sqlFiles().filter((f) => !baseFiles.has(f));

if (ours.length === 0) {
  console.log(`No migrations beyond ${base}'s; nothing to rebase.`);
} else {
  const before = ours.map((f) => fs.readFileSync(path.join(DIR, f), "utf8")).join("\n");
  const name = ours[0]!.replace(/^\d+_/, "").replace(/\.sql$/, "");
  if (ours.length > 1) console.warn(`Combining ${ours.join(", ")} into one migration named ${name}.`);

  for (const f of ours) fs.rmSync(path.join(DIR, f));
  git("checkout", base, "--", `${DIR}/meta`);
  for (const f of fs.readdirSync(path.join(DIR, "meta"))) {
    if (!baseMeta.has(f)) fs.rmSync(path.join(DIR, "meta", f));
  }

  execFileSync("npx", ["drizzle-kit", "generate", "--name", name], { stdio: "inherit" });

  const fresh = sqlFiles().filter((f) => !baseFiles.has(f));
  const after = fresh.map((f) => fs.readFileSync(path.join(DIR, f), "utf8")).join("\n");
  if (squash(after) !== squash(before)) {
    console.error(`\nThe regenerated SQL differs from the branch's. Before:\n${before}\nAfter:\n${after}`);
    console.error("Check for a hand-edited migration or schema drift, then fix by hand.");
    process.exit(1);
  }
  console.log(`Rebased ${ours.join(", ")} onto ${base} as ${fresh.join(", ")}; SQL unchanged.`);
}

const freshDb = openDatabase(":memory:", DIR);
console.log(`Fresh database migrates to ${freshDb.migrationVersion()}.`);
freshDb.close();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "db-rebase-"));
try {
  execFileSync("sh", ["-c", `git archive ${base} ${DIR} | tar -x -C "${tmp}"`]);
  const file = path.join(tmp, "upgrade.db");
  const onBase = openDatabase(file, path.join(tmp, DIR));
  const from = onBase.migrationVersion();
  onBase.close();
  const upgraded = openDatabase(file, DIR);
  console.log(`Database on ${base} (${from}) upgrades to ${upgraded.migrationVersion()}.`);
  upgraded.close();
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

git("add", DIR);
execFileSync("npx", ["drizzle-kit", "check"], { stdio: "inherit" });
