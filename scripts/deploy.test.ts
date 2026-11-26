import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs scripts/deploy.sh against a temp directory: a local git repo as the source, a fake npm,
// fake node (the pre-deploy backup) and systemctl that only log, and a file:// health URL the test controls.

const SCRIPT = path.resolve(import.meta.dirname, "deploy.sh");
const OLD = "a".repeat(40);

let dir: string;
let root: string;
let logFile: string;
let healthFile: string;
let sha: string;

function write(file: string, content: string, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-deploy-"));
  root = path.join(dir, "srv");
  logFile = path.join(dir, "log");
  healthFile = path.join(dir, "healthz.json");
  write(logFile, "");

  const repo = path.join(dir, "repo");
  write(path.join(repo, "README.md"), "release\n");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).toString().trim();
  git("init", "--quiet", "-b", "master");
  git("add", ".");
  git("commit", "--quiet", "-m", "release");
  sha = git("rev-parse", "HEAD");

  // The release that is live before each deploy.
  write(path.join(root, "releases", OLD, "marker"), "old");
  fs.symlinkSync(path.join(root, "releases", OLD), path.join(root, "current"));

  write(
    path.join(dir, "bin", "npm"),
    `#!/usr/bin/env bash
echo "npm $*" >> "${logFile}"
[[ "$*" == "$FAKE_NPM_FAIL" ]] && exit 1
exit 0
`,
    0o755,
  );
  write(
    path.join(dir, "bin", "systemctl"),
    `#!/usr/bin/env bash\necho "systemctl $*" >> "${logFile}"\n`,
    0o755,
  );
  write(
    path.join(dir, "bin", "node"),
    `#!/usr/bin/env bash\necho "node $* db=$DATABASE_PATH" >> "${logFile}"\n[[ -z "$FAKE_NODE_FAIL" ]]\n`,
    0o755,
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function deploy(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CC_ROOT: root,
      CC_REPO_URL: path.join(dir, "repo"),
      CC_DB: path.join(dir, "db", "app.db"),
      CC_BACKUP_DIR: path.join(dir, "backups"),
      CC_SYSTEMCTL: path.join(dir, "bin", "systemctl"),
      CC_NPM: path.join(dir, "bin", "npm"),
      CC_NODE: path.join(dir, "bin", "node"),
      CC_HEALTH_URL: `file://${healthFile}`,
      CC_HEALTH_TIMEOUT: "1",
      CC_HEALTH_INTERVAL: "0.2",
      ...env,
    },
  });
  return { ...result, log: fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean) };
}

const current = () => path.basename(fs.readlinkSync(path.join(root, "current")));
const releases = () => fs.readdirSync(path.join(root, "releases")).sort();

describe("deploy.sh", () => {
  it("builds, backs up, switches and restarts when the health check reports the new SHA", () => {
    write(healthFile, JSON.stringify({ sha, migration: "0000_x" }));

    const run = deploy([sha]);

    expect(run.status, run.stderr).toBe(0);
    expect(current()).toBe(sha);
    expect(run.log).toEqual([
      "npm ci",
      "npm run check",
      "npm run build",
      `node dist/server/backup.js --kind pre-deploy --label ${sha.slice(0, 12)} db=${path.join(dir, "db", "app.db")}`,
      "systemctl restart class-connect.service",
    ]);
    expect(fs.existsSync(path.join(root, "releases", sha, "README.md"))).toBe(true);
  });

  it.each(["ci", "run check", "run build"])(
    "fails before the switch, leaving the running release alone, when npm %s fails",
    (step) => {
      const run = deploy([sha], { FAKE_NPM_FAIL: step });

      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("the running release is untouched");
      expect(current()).toBe(OLD);
      expect(releases()).toEqual([OLD]); // the half-built release is removed
      expect(run.log.some((line) => line.startsWith("systemctl") || line.startsWith("node"))).toBe(false);
    },
  );

  it("fails before the switch when the pre-deploy backup fails", () => {
    const run = deploy([sha], { FAKE_NODE_FAIL: "1" });

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("backup failed");
    expect(current()).toBe(OLD);
    expect(run.log.some((line) => line.startsWith("systemctl"))).toBe(false);
  });

  it("rolls back to the previous release when the health check never reports the new SHA", () => {
    write(healthFile, JSON.stringify({ sha: OLD, migration: "0000_x" }));

    const run = deploy([sha]);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("rolled back");
    expect(current()).toBe(OLD);
    expect(run.log.filter((line) => line.startsWith("systemctl"))).toEqual([
      "systemctl restart class-connect.service",
      "systemctl restart class-connect.service",
    ]);
  });

  it("rolls back when the health endpoint is unreachable", () => {
    const run = deploy([sha]);
    expect(run.status).not.toBe(0);
    expect(current()).toBe(OLD);
  });

  it("keeps the last 5 releases, never the live or previous one", () => {
    // Six older releases, oldest first by mtime.
    for (let i = 1; i <= 6; i++) {
      const release = path.join(root, "releases", `${i}`.repeat(40));
      write(path.join(release, "marker"), "");
      const t = new Date(Date.UTC(2026, 0, i));
      fs.utimesSync(release, t, t);
    }
    // The live release is the oldest of all, so only the "previous" rule keeps it.
    fs.utimesSync(path.join(root, "releases", OLD), new Date(0), new Date(0));
    write(healthFile, JSON.stringify({ sha }));

    const run = deploy([sha]);

    expect(run.status, run.stderr).toBe(0);
    expect(releases()).toEqual(
      [sha, "6".repeat(40), "5".repeat(40), "4".repeat(40), "3".repeat(40), OLD].sort(),
    );
  });

  it("rejects something that is not a SHA", () => {
    const run = deploy(["master; rm -rf /"]);
    expect(run.status).not.toBe(0);
    expect(current()).toBe(OLD);
  });

  it("restores a chosen backup with the service stopped, keeping the replaced database aside", () => {
    const db = path.join(dir, "db", "app.db");
    write(db, "live");
    write(`${db}-wal`, "wal");
    const backup = path.join(dir, "backups", "nightly-20261125T030000Z.db");
    write(backup, "backup");

    const run = deploy(["--restore", backup]);

    expect(run.status, run.stderr).toBe(0);
    expect(fs.readFileSync(db, "utf8")).toBe("backup");
    expect(fs.existsSync(`${db}-wal`)).toBe(false);
    const aside = fs.readdirSync(path.dirname(db)).filter((n) => n.includes(".before-restore-"));
    expect(aside).toHaveLength(2);
    expect(run.log).toEqual([
      "systemctl stop class-connect.service",
      "systemctl start class-connect.service",
    ]);
  });
});
