# Development

Node 22.12 or newer.

```sh
npm install
cp .env.example .env          # then fill in the two secrets:
npm run hash-password -- <pw> # → LECTURER_PASSWORD_HASH
                              # COOKIE_SECRET: any long random string
npm run dev                   # Hono on :3000, Vite on :5173 (proxies /api and /healthz)
```

Open `http://localhost:5173/lecturer` and sign in.

| Command | What it does |
|---|---|
| `npm run check` | Type check, lint (including the module-boundary and test-SQL rules), migration snapshot check, every test. |
| `npm run check:ci` | `check` plus the production build. CI runs it on each PR and push; run it before merging into `dev`. |
| `npm test` | Vitest in watch mode. |
| `npm run build` | Front end to `dist/client`, server bundle to `dist/server`. |
| `npm start` | Runs the built server (migrations apply at startup, then it listens on `127.0.0.1`). |
| `npm run backup -- --kind nightly\|pre-deploy` | Consistent copy of `DATABASE_PATH` into `BACKUP_DIR` (default `/mnt/d/class-connect-backups`), pruned to 14 nightly and 5 pre-deploy. Needs `npm run build` first. |
| `npm run deploy -- <sha>` | Runs `scripts/deploy.sh <sha>` on the home server over `ssh wsl` (the manual fallback). |
| `npm run seed:demo -- --date <YYYY-MM-DD> --start <HH:MM> --end <HH:MM> [--replace]` | Builds the demo Course in `DATABASE_PATH` through module operations, with the canned fake LLM (README, Rehearsing the demo). |
| `npm run db:generate -- --name <name>` | Generates a migration from the module schema files. Migrations are additive only. |
| `npm run db:rebase [-- <base>]` | After merging `dev` (or `<base>`) in: keeps its migrations, regenerates this branch's on top with the next free number, refuses if the SQL changed, and checks fresh and upgrade migration. Use it whenever two branches took the same migration number. |

## Where things go

- `src/server/<module>/`: one folder per module. Feature modules (Course, Attendance, Feedback, Summaries, Homework) and infrastructure (`clock`, `live-events`, `llm`, `jobs`, `files`, `db`). Each module's `index.ts` is its interface; a lint rule stops code outside a module importing anything else from it. A module's tables live in its `schema.ts`.
- `src/server/demo/`: the rehearsal fixtures behind `LLM_ADAPTER=fake` and `seed:demo`. The fixture files themselves (invented Transcripts, seeded Submissions, one canned-reply file per LLM task, each checked against its task's schema at load) are in `fixtures/`.
- `src/server/http/`: thin Hono routes that call module interfaces.
- `src/server/testing/`: `makeTestApp`, the fakes and the builders (`docs/testing-strategy.md`).
- `src/client/`: the React app. `live.ts` maps each Live events notice type to the queries it refetches; add an entry when the server gains a notice type (the type check enforces it).
- `src/shared/`: types both sides use.

Agents branch from `dev` and open PRs into `dev`.

Put `Closes #<ticket>` in the PR body. A merge into `dev` closes that ticket (the `close tickets on dev merge` workflow), which unblocks the tickets waiting on it.

## Deploy

Every push to `master` deploys (#19, ADR 0003). The `check` workflow runs `check` on a GitHub-hosted runner, then the `deploy` job runs on the self-hosted runner labelled `wsl` on the home server and calls `scripts/deploy.sh <sha>`:

1. clone the commit into `/srv/class-connect/releases/<sha>` (under a temporary name until it builds);
2. `npm ci`, `npm run check`, `npm run build` there;
3. pre-deploy backup (`dist/server/backup.js --kind pre-deploy`);
4. repoint `/srv/class-connect/current`, restart `class-connect.service`;
5. poll `https://cc.ofeq.dev/healthz` for ~30 s until it reports the SHA, else point back to the previous release, restart and fail the run.

A failure in steps 1–3 leaves the running release alone. The last 5 releases are kept. The database is never restored automatically; to restore one, run `scripts/deploy.sh --restore /mnt/d/class-connect-backups/<file>.db` on the box (or `npm run deploy -- --restore <file>` from the laptop). It stops the service, moves the current database aside as `app.db.before-restore-<time>`, copies the backup in and starts the service.

Paths, the service name, the health URL and the commands are overridable with `CC_*` variables (listed at the top of the script); `scripts/deploy.test.ts` uses them to run the script on a temp directory with fakes.

`deploy/` holds the systemd units: `class-connect.service` and the nightly `class-connect-backup.timer` + `.service`. Installing them, the runner, `/etc/class-connect.env` and the sudoers rule for `systemctl` is #23.
