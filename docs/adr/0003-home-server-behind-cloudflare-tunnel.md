# Host on the home server behind a Cloudflare Tunnel, not on Fly.io

The stack research recommended one Fly.io machine with a volume. Instead, Class Connect runs as a single Node process (Hono + SQLite) on the Lecturer-developer's always-on home server (`wsl`, WSL2 Ubuntu), served at `cc.ofeq.dev` through the Cloudflare Tunnel that is already set up there. We chose this because the machine and tunnel already exist and are always on, cost nothing, and leave the architecture unchanged: one process, one SQLite file, Server-Sent Events, an in-process job worker.

## Considered Options

- **Fly.io machine with a volume** (the research recommendation): rejected. It needs a card, a new deploy pipeline and volume backups, for no gain over a server that is already running.
- **Cloudflare Workers with a Durable Object per Session**: rejected. It is a less familiar model and would split the in-process job worker and event bus across a different runtime.

## Consequences

- The client IP is read from `CF-Connecting-IP`. The app binds to `127.0.0.1` so it can be reached only through the tunnel; otherwise that header could be forged.
- Cloudflare's proxy serves every hostname over both IPv4 and IPv6, so a single-family subdomain cannot reveal the Lecturer's other address. The Lecturer's browser asks `api4.ipify.org` and `api6.ipify.org` instead and reports both.
- Cloudflare closes a proxied connection after about 100 seconds without data, so SSE streams send a heartbeat every ~25 seconds.
- Backups are a consistent copy made by the app itself (`better-sqlite3` `db.backup()`; the box has no `sqlite3` CLI), nightly from a systemd timer and before every deploy, to the Windows `D:` drive (`/mnt/d`). There are no volume snapshots.
- Deploys run on the box: a merge to `master` passes CI, then a self-hosted GitHub Actions runner on the home server builds the commit into its own release directory, swaps a `current` symlink and restarts the systemd unit, rolling back if `/healthz` doesn't report the new commit. A GitHub-hosted runner can't reach the box, which accepts no inbound connections except through the tunnel.
- Migrations run at app startup and stay additive, so the previous release still runs against the newer schema after a rollback.
- There is no fallback host. If the home server is down during class, the demo is down.
