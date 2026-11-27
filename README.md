<img src="assets/icon.svg" width="64" height="64" alt="">

# Class Connect

Simple, phone-first teaching tools for a live Course: QR code Check-in with a downloadable Attendance sheet, real-time Comments and Polls, LLM Session summaries, and homework Reviews with peer Help matching. Students use a web app on their own phones; the Lecturer uses a console on a laptop.

**Start here:** [problem and scope](docs/README.md), then the [Statement of Work](docs/statement-of-work.md), [SRS](docs/srs.md), [use cases](docs/use-cases.md), [components](docs/components.md), [class](docs/diagrams/class-diagram.md) and [sequence](docs/diagrams/sequence-diagrams.md) diagrams, and the [testing strategy](docs/testing-strategy.md).

Vocabulary: [`GLOSSARY.md`](GLOSSARY.md). Decisions: [`docs/adr/`](docs/adr/).

## Setting up the home server

The app runs on the home server behind the Cloudflare Tunnel at `cc.ofeq.dev` ([ADR 0003](docs/adr/0003-home-server-behind-cloudflare-tunnel.md)); every merge to `master` deploys there. To install it, or rebuild it later, run the wizard from a laptop checkout with `ssh wsl` and `gh` working:

```sh
deploy/setup-home-server.sh
```

It walks through each step: directories, the sudoers rule for restarts, `/etc/class-connect.env`, the systemd units, the GitHub runner and the tunnel route. It finishes with the acceptance checks from #23: a deploy, a rollback drill and a backup. It is safe to rerun. The values you enter are kept outside the repo in `~/.local/state/class-connect/server.env`. Backups cover the database only, not the uploaded files under `FILES_DIR`.

## Rehearsing the demo

The full plan is [Rehearsing the live demo](docs/testing-strategy.md#rehearsing-the-live-demo). In short, on the home server, from `/srv/class-connect/current`:

1. Set `LLM_ADAPTER=fake` in `/etc/class-connect.env` and restart the service. Every LLM task now answers from the canned replies in [`fixtures/`](fixtures/) after `FAKE_LLM_DELAY_MS` (1500 ms), still counting in `llm_usage`.
2. Seed the demo Course for the day you rehearse (re-enacted history never runs ahead of now, so Assignment 2 is only due, and the review run only possible, once its date has passed):
   `DATABASE_PATH=/var/lib/class-connect/app.db FILES_DIR=/var/lib/class-connect/files npm run seed:demo -- --date <YYYY-MM-DD> --start <HH:MM> --end <HH:MM> --replace`
   It prints the demo Session's QR link and the demo IDs that have a Submission. `--replace` sets the old demo Course aside (renamed, Claims reset); without it the seed refuses to run over one.
3. Walk the demo script on an iPhone, an Android phone and the laptop (testing strategy, step 2): claim and check in, a Pending check-in and Network approval, a quick reaction, the "How is the pace so far?" Poll, generate and publish the clip's summary and switch language, a review run, Release, a Help request and Match now, the Attendance sheet, and a phone left idle for two minutes.
4. The day before class: one real-LLM dry run (`LLM_ADAPTER=openrouter`) on the 5-minute clip and a small review run.
5. On the day: reseed with the demo's date and times and `--replace`, switch back to `LLM_ADAPTER=openrouter`, check the `llm_usage` count in the console and that the nightly backup ran.
