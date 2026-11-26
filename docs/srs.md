# Software Requirements Specification

Class Connect, version 1 (the classroom demo). Terms follow [`GLOSSARY.md`](../GLOSSARY.md) and have that meaning wherever they're capitalised.

## 1. Introduction

### 1.1 Purpose

This document states what Class Connect must do and how well, for the AI agents that build it and the staff who assess it. Every requirement here comes from a decision on the [wayfinder map](https://github.com/ofeq-dev/class-connect/issues/1); the source ticket or ADR is given for each group.

### 1.2 Scope

Class Connect is a hosted web app with two surfaces: a **Student phone app** and a **Lecturer console**, plus a public **Projector window**. It covers attendance (tier 1), Comments and Polls (tier 2), and Session summaries and homework Reviews (tier 3). See the [README](README.md) for the problem and what is out of scope.

### 1.3 Conventions

- **Must** marks a requirement for the demo. **Should** marks one that may be cut if time runs out, in tier order.
- IDs: `FR-<area>-<n>` for functional requirements, `NFR-<n>` for non-functional ones. Use cases in [use-cases.md](use-cases.md) cite these IDs.
- Areas: `ID` identity, `ATT` attendance, `FB` Comments and Polls, `SUM` Session summaries, `HW` homework, `LC` Lecturer console, `SA` Student app.

### 1.4 References

[README](README.md) · [Statement of Work](statement-of-work.md) · [Use cases](use-cases.md) · [Components](components.md) · [Class diagram](diagrams/class-diagram.md) · [Sequence diagrams](diagrams/sequence-diagrams.md) · [Testing strategy](testing-strategy.md) · [ADR 0001](adr/0001-qr-and-network-check-in-instead-of-photo-count.md) · [ADR 0002](adr/0002-no-student-accounts-roster-claim-and-device-binding.md) · [ADR 0003](adr/0003-home-server-behind-cloudflare-tunnel.md)

## 2. Overall description

### 2.1 Product perspective

A new, self-contained system. It runs as one Node process on the developer's home server, reached at `https://cc.ofeq.dev` through a Cloudflare Tunnel. It uses two outside services: OpenRouter (free LLM models) and ipify (the Lecturer's browser looks up its own public addresses). It doesn't integrate with Zoom, Meet or Google Classroom; the Lecturer uploads a Zoom Transcript file by hand.

### 2.2 Who uses it

| Who | Device | Frequency | Needs |
|---|---|---|---|
| **Student** | Own phone, any current iOS Safari or Android Chrome | Every Session, a few taps | Check in with one scan, react or vote with one tap, no account or install |
| **Lecturer** | Laptop on an extended display (console private, projector public) | Every Session; setup at the start of term | A calm live view of attendance, Comments and the current Poll; the Attendance sheet; review and publish LLM output |
| **Classroom audience** | The projector, via the Projector window | During a Session | The QR code and live count, or the current Poll |

There is exactly one Lecturer account. It can run several Courses.

### 2.3 Operating environment

- Server: Node 22 on WSL2 Ubuntu (`wsl`), systemd unit, bound to `127.0.0.1`, behind `cloudflared`.
- Clients: current mobile Safari and Chrome for Students; a current desktop browser for the Lecturer.
- Classroom network: `Ariel-University` Wi-Fi, leaving through a pool in `192.114.52.0/24`, IPv4 only.

### 2.4 Design and implementation constraints

- TypeScript throughout: Hono server, React (Vite) client, Drizzle over SQLite (`better-sqlite3`, WAL), Server-Sent Events. See [components](components.md).
- LLM calls only through OpenRouter free models, at most 1000 requests a day.
- No paid services, no native apps, no Student passwords.
- Built by AI agents through pull requests; every merge to `master` deploys.

### 2.5 Assumptions and dependencies

- The Lecturer opens the Check-in window while on the classroom Wi-Fi.
- A Zoom VTT (or plain text) Transcript is available for each Session to be summarised.
- OpenRouter's free models and ipify are reachable on demo day.

## 3. Functional requirements

### 3.1 Identity — [ADR 0002](adr/0002-no-student-accounts-roster-claim-and-device-binding.md), [#5](https://github.com/ofeq-dev/class-connect/issues/5)

| ID | Requirement |
|---|---|
| FR-ID-1 | The Lecturer must sign in with one password set in server configuration; the server then keeps a signed session cookie. |
| FR-ID-2 | The Lecturer must be able to import a Roster per Course from a CSV of name and student ID. Bad rows are reported, and re-importing doesn't duplicate student IDs. |
| FR-ID-3 | The Lecturer must be able to add a single Student to the Roster by hand. |
| FR-ID-4 | A Student must be able to Claim their Roster entry by entering their student ID and confirming "You are <name>. Correct?". |
| FR-ID-5 | The first Claim of an entry wins. A Claim binds one Student to one phone: a phone that has claimed one entry can't claim another, and a claimed entry can't be claimed from another phone. |
| FR-ID-6 | A Claim must set a device-token cookie (`httpOnly`, `Secure`, `SameSite=Lax`, 400 days), refreshed on each visit. Only the token's hash is stored. |
| FR-ID-7 | The Lecturer must be able to do a Claim reset with one tap in the Roster; it takes effect at once and never changes attendance. |
| FR-ID-8 | An unclaimed phone that opens a Session's QR code link must go through Claim and then Check-in in one flow. |

### 3.2 Attendance — [ADR 0001](adr/0001-qr-and-network-check-in-instead-of-photo-count.md), [#6](https://github.com/ofeq-dev/class-connect/issues/6), [#10](https://github.com/ofeq-dev/class-connect/issues/10), [#16](https://github.com/ofeq-dev/class-connect/issues/16)

| ID | Requirement |
|---|---|
| FR-ATT-1 | Each Session must have one fixed QR code encoding `https://cc.ofeq.dev/s/<code>`. |
| FR-ATT-2 | The Lecturer must be able to open and close the Check-in window, and reopen it, keeping earlier Check-ins. It closes automatically at midnight. |
| FR-ATT-3 | When the window opens, the Lecturer's browser must look up its own public IPv4 and IPv6 addresses (ipify) and report both; they are captured afresh on every opening. |
| FR-ATT-4 | Loading the QR code link on a claimed phone while the window is open must check the Student in with no tap. |
| FR-ATT-5 | A Check-in from an address in the Lecturer's IPv4 `/24` or IPv6 `/64`, or in a block approved for this Session, must count as Present. IPv4 is compared only with IPv4 and IPv6 only with IPv6; IPv4-mapped IPv6 counts as IPv4. The client address is read from `CF-Connecting-IP`. |
| FR-ATT-6 | A Check-in from any other network must be recorded as a Pending check-in, and the Student told "Checked in — waiting for your Lecturer to confirm". |
| FR-ATT-7 | The Lecturer must see Pending check-ins grouped by network block, and a Network approval (one tap) must turn that block's Pending check-ins into Present. Later Check-ins from that block in the same Session count as Present. |
| FR-ATT-8 | A Network approval must last for that Session only. No number of Pending check-ins approves a block automatically. |
| FR-ATT-9 | A Pending check-in still unapproved when the window closes must read as Absent. |
| FR-ATT-10 | A Check-in while the window is closed must be refused, telling the Student to ask the Lecturer to mark them present. |
| FR-ATT-11 | The Lecturer must be able to Manual mark any Student present or absent for a Session at any time, window open or closed; the latest action wins. |
| FR-ATT-12 | Attendance must belong to the Roster entry, never the phone. Each Check-in record logs the Roster entry, IP address, block and device token. |
| FR-ATT-13 | The Lecturer must see attendance live: a count ("19 of 32 present") and lists of present, not here yet and waiting for approval. |
| FR-ATT-14 | The Lecturer must be able to download the per-Course Attendance sheet as xlsx: one row per Roster entry (including Students who never claimed), one column per Session by date, each cell Present, Manual or Absent; a per-Student total (count and %, Manual counting as attended) and a per-Session headcount row. Check-in times are stored but not shown. |

### 3.3 Comments and Polls — [#7](https://github.com/ofeq-dev/class-connect/issues/7), [#11](https://github.com/ofeq-dev/class-connect/issues/11), [#17](https://github.com/ofeq-dev/class-connect/issues/17)

**Topics**

| ID | Requirement |
|---|---|
| FR-FB-1 | Every Course must have a General Topic and one Topic per Session (worked out by Feedback from the Course's Sessions, stored the first time a Comment or Poll uses it). The Lecturer must be able to add, rename and archive named Topics (such as "Assignment 2" or "Midterm"). Archiving hides a Topic from Students and keeps its Comments and Polls. |

**Comments**

| ID | Requirement |
|---|---|
| FR-FB-2 | Any Student with a claimed Roster entry must be able to send a Comment on a Topic at any time. |
| FR-FB-3 | A Comment is named by default; the Student must be able to switch it to anonymous. The Lecturer never sees an anonymous Comment's author; the server keeps the Roster entry. |
| FR-FB-4 | A Comment on a Session Topic must be tagged before, during or after from the Session's scheduled start and end. On a Session Topic the Lecturer sees a presence note (checked in or not), also on anonymous Comments. |
| FR-FB-5 | A Comment must be visible only to the Lecturer and its author. There are no written replies. |
| FR-FB-6 | The Lecturer must be able to move a Comment freely between New, Pinned, Addressed and Ignored. A Pinned Comment stays at the top of every later Session's view until it is Addressed. |
| FR-FB-7 | The Lecturer must be able to filter Comments by Topic, Student (including "Anonymous"), status and before / during / after, newest first. |
| FR-FB-8 | A Student must see their own Comments with their status, and be able to delete one while it is New. Comments can't be edited. |
| FR-FB-9 | The Student app must offer one-tap quick reactions (such as "Too fast", "Can you repeat that?") that send an ordinary Comment at once, with Undo. The Lecturer sees identical quick reactions grouped with a count. |

**Polls**

| ID | Requirement |
|---|---|
| FR-FB-10 | The Lecturer must be able to create a single-choice Poll with 2–6 options on a Topic (default: the current Session), as a draft in advance or on the spot. An incomplete draft can be saved but not opened. |
| FR-FB-11 | A Poll must open and close by hand, on a schedule, or both; the latest action wins. Several Polls may be open at once. A closed Poll can't reopen (the Lecturer copies it instead). |
| FR-FB-12 | Any claimed Student must be able to Vote with one tap, once per Roster entry, and change the Vote while the Poll is open. |
| FR-FB-13 | The Lecturer must see live totals only, never who voted for what. Students must see the totals only once the Poll closes. |
| FR-FB-14 | A Poll that opens while the Student app is open must show a badge on the Polls tab and a banner; the app never switches tab on its own. |
| FR-FB-15 | Past Polls must be browsable by Topic. |

### 3.4 Session summaries — [#2](https://github.com/ofeq-dev/class-connect/issues/2), [#8](https://github.com/ofeq-dev/class-connect/issues/8)

| ID | Requirement |
|---|---|
| FR-SUM-1 | The Lecturer must be able to give a Session a Transcript as a `.vtt` or `.txt` upload or as pasted text. VTT cue numbers are stripped and timestamps kept. A Transcript with no timestamps is accepted, with the warning "No timestamps found — the outline won't have times." |
| FR-SUM-2 | Generating must make one background request to an OpenRouter free model (fallback list, 3-minute timeout) and produce, in the Transcript's language: an overview paragraph, an outline of topics, each with a start timestamp when the Transcript has them, key points, and 3–5 review questions. |
| FR-SUM-3 | While generating, the Lecturer must see "Summarising…"; if every model fails or the daily limit is reached, an error and a Retry. |
| FR-SUM-4 | A Session must have at most one Session summary. The Lecturer must be able to edit it as Markdown in a text box with a live preview. Regenerating asks for confirmation. |
| FR-SUM-5 | Every generation and every saved edit must add a version recording its time and whether the AI or the Lecturer made it. The Lecturer can view and restore versions; restoring copies the old version as the newest. |
| FR-SUM-6 | A Session summary must be hidden from Students until the Lecturer publishes a version; then every Student with a claimed Roster entry sees that version only. |
| FR-SUM-7 | The Lecturer must be able to set extra languages per Course. Publishing must make one translation per language from the published version, keeping timestamps; translations can be edited, and publishing again regenerates them after a confirm. |
| FR-SUM-8 | A Student must be able to switch language, defaulting to their browser language when a translation exists, else the source language. |
| FR-SUM-9 | Rendered text must set its direction per block from its own text (right-to-left for Hebrew or Arabic), with timestamps left-to-right. |

### 3.5 Homework — [#4](https://github.com/ofeq-dev/class-connect/issues/4), [#9](https://github.com/ofeq-dev/class-connect/issues/9), [#15](https://github.com/ofeq-dev/class-connect/issues/15)

**Assignments and Submissions**

| ID | Requirement |
|---|---|
| FR-HW-1 | The Lecturer must be able to set an Assignment on a Course with instructions, a due date and 3–5 Criteria. The LLM may draft Criteria for the Lecturer to edit. |
| FR-HW-2 | A Student must be able to hand in one Submission per Assignment as pasted text or a PDF (text extracted in-app), and replace it until the due date. One handed in after the due date is accepted and marked Late. |

**Review run**

| ID | Requirement |
|---|---|
| FR-HW-3 | The Lecturer must be able to start a review run. Each Submission gets one structured LLM call producing, per Criterion, a level (Not yet / Partly / Secure), a short evidence quote and feedback. There is no overall mark. |
| FR-HW-4 | The Lecturer must see the run's progress and a Retry on each Submission whose review failed after 3 attempts. Other Submissions are unaffected. |
| FR-HW-5 | Once every Submission's review has settled, the app must compute similarity (fingerprints plus one batched embedding call) and one class summary (counts per Criterion and common mistakes), over the Reviews that succeeded. A successful Retry re-runs both. |
| FR-HW-6 | The Lecturer must see Submission pairs above a similarity threshold, each with a score, both signals and the overlapping passages side by side. A pair never changes a level or blocks Release. Students never see similarity. |
| FR-HW-7 | The Lecturer must be able to edit any draft Review. |

**Release**

| ID | Requirement |
|---|---|
| FR-HW-8 | Release must publish every Review and the class summary of an Assignment at once, and open Help requests and offers. It is refused while any on-time Submission has no Review. |
| FR-HW-9 | A Student must see, after Release, only their own Review and the class summary. Class aggregates are hidden below 5 Submissions and never contain names, rankings or classmates' text. |
| FR-HW-10 | A Late Submission arriving after Release must get its own Review, join similarity, and be released on its own; the released class summary stays unchanged. |

**Help matching**

| ID | Requirement |
|---|---|
| FR-HW-11 | After Release, a Student at Not yet or Partly on a Criterion must be able to make a Help request for it, and a Student at Secure on it must be able to offer to be a Helper. Neither knows who is on the other side. |
| FR-HW-12 | The app (no LLM) must make Help matches in one pass at the match deadline (set at Release, default 2 days later), or earlier when the Lecturer presses Match now. Not yet requests go before Partly, ties to whoever asked first; each goes to the Helper with the fewest matches so far, at most 2 per Helper per Criterion. |
| FR-HW-13 | Matched Students must see each other's names ("You and X are paired for Q2"); nobody ever sees anyone's level. An unmatched request reads "No Helper this time — ask your Lecturer"; an unmatched offer is thanked. |
| FR-HW-14 | After the pass, no more Help requests or offers are taken. The Lecturer sees all requests, offers and matches. |

### 3.6 Lecturer console — [#17](https://github.com/ofeq-dev/class-connect/issues/17)

| ID | Requirement |
|---|---|
| FR-LC-1 | The live console must show three columns, Attendance, Comments (widest) and Poll, each a summary with detail on demand, in the Binder look (Attendance yellow, Poll pink, Comments green, Roster blue). |
| FR-LC-2 | The header must show the Session, the time and Projector control (QR + count / Poll / Blank) with a live thumbnail. A ⋯ menu holds the Roster, Download attendance sheet and Diagnostics. |
| FR-LC-3 | The Attendance column must show the count, the window state with one Close / Reopen button, one card per network with Pending check-ins and an **Approve network** button, and expandable lists with ✓ / ✕ Manual mark icons and Undo. |
| FR-LC-4 | The Comments column must show Pinned Comments on top, Topic filter chips with open counts, icon actions (pin, Addressed, Ignore) with Undo, and Addressed and Ignored Comments folded under "Dealt with (n)". |
| FR-LC-5 | The Poll column must show only the current Poll (focused, else open, else next scheduled); others sit behind "All polls (n)". A closed Poll stays on the card with its results until **Done**. |
| FR-LC-6 | IP addresses, network blocks and a short device ID (the first 6 characters of the stored device-token hash) must be shown only when the Diagnostics flag is on (off by default). |
| FR-LC-7 | The Projector window must be its own page, updated live, showing either the QR code with the Session title and checked-in count, or the current Poll with its vote count (results only after it closes), or nothing. It never shows Comments or Pending names. It opens from an unguessable per-Course link (`/p/<secret>`) with no sign-in, so a classroom PC can be set up once; the Lecturer can make a new link, which stops the old one working. It shows the Course's Session whose projector mode was set most recently, else Blank. The projector mode is server state, so the console thumbnail, the window and a classroom PC always agree. |
| FR-LC-8 | The console must show today's LLM request count against the 1000-a-day limit. |
| FR-LC-9 | Outside a live Session, the Lecturer must work from a **Course desk** per Course: its Sessions (with **Open live console** for today's), Session summaries and Assignments, with the Roster, Topics, Course settings, Download attendance sheet and Diagnostics in its ⋯ menu. Those screens keep the live console's Binder look; tier 3 screens are minimal. |

### 3.7 Student phone app — [#11](https://github.com/ofeq-dev/class-connect/issues/11)

| ID | Requirement |
|---|---|
| FR-SA-1 | The app must have four bottom tabs in the Binder look, each with its own highlighter colour: **Today** (Session, Check-in status, shortcuts to open Polls and commenting, then a **Session summaries** list and an **Assignments** list, each opening a plain sub-page for reading a summary, handing in a Submission, reading a Review and asking for or offering help; yellow), **Polls** (open Polls, then results of closed ones; pink), **Comment** (Topic, text, anonymous switch, quick reactions, Send; green), **Mine** (own Comments with status; blue). |
| FR-SA-2 | Check-in status and its problems (off-network Pending, window closed) must show in the same spot on Today. |
| FR-SA-3 | The app should offer a dark theme. |

## 4. Non-functional requirements

| ID | Quality | Requirement |
|---|---|---|
| NFR-1 | Simplicity | Check-in takes zero taps after the scan on a claimed phone; a Vote and a quick reaction take one tap each. Students install nothing and type no password. |
| NFR-2 | Responsiveness | A Check-in, Comment or Vote appears on the Lecturer console without a reload, within a couple of seconds on the classroom Wi-Fi. |
| NFR-3 | Real-time robustness | Live streams send a heartbeat every ~25 s so Cloudflare keeps them open; after a reconnect, a page refetches everything it shows. |
| NFR-4 | Capacity | One Course of about 30–40 Students checking in within a minute, on one process and one SQLite file. |
| NFR-5 | LLM budget | At most 1000 OpenRouter requests a day, at most ~15 a minute, one at a time. A Session summary costs ~2–5 requests; a review run of 30 costs ~35. |
| NFR-6 | LLM resilience | Every LLM task uses a fallback list of free models, a per-task timeout and one schema-fix retry, and fails to a visible error with Retry, never a hang. |
| NFR-7 | Privacy | The Lecturer never sees an anonymous Comment's author, who voted for what, or an IP address (outside Diagnostics). Students never see classmates' names, levels or text, except their own Help match partner's name. Requests to OpenRouter set `data_collection: "deny"`. |
| NFR-8 | Security | The app binds to `127.0.0.1` and is reachable only through the tunnel, so `CF-Connecting-IP` can be trusted. Only device-token hashes are stored. Rendered Markdown is sanitised. |
| NFR-9 | Durability | Background jobs survive a restart: interrupted jobs re-run, completed ones never do, and a job that keeps failing ends `failed` with Retry after 3 attempts. The database is backed up nightly and before every deploy. |
| NFR-10 | Deployability | A merge to `master` deploys automatically; a failed health check rolls back to the previous release. Migrations are additive only. |
| NFR-11 | Accessibility and language | Readable type (Atkinson Hyperlegible body), per-block text direction for right-to-left languages, works on current iOS Safari and Android Chrome. |
| NFR-12 | Testability | Feature modules are testable through their interfaces with fakes for the five injected seams; `npm run check` runs type check, lint and all tests. See the [testing strategy](testing-strategy.md). |
| NFR-13 | Maintainability | Routes call only module interfaces; a lint rule stops a module importing another module's internals. |

## 5. External interfaces

| Interface | Direction | Purpose |
|---|---|---|
| Student browser | HTTPS + SSE | Student phone app at `cc.ofeq.dev` |
| Lecturer browser | HTTPS + SSE | Lecturer console and Projector window |
| ipify (`api4` / `api6.ipify.org`) | Lecturer browser → ipify | The Lecturer's own public IPv4 and IPv6 when the window opens |
| OpenRouter | Server → OpenRouter | Chat completions (summaries, translations, Reviews, class summary, Criteria drafts) and embeddings |
| Cloudflare Tunnel | Internet → server | TLS, routing, `CF-Connecting-IP` |
| Files in | Lecturer / Student upload | Roster CSV, Transcript `.vtt` / `.txt`, Submission PDF |
| Files out | Download | Attendance sheet `.xlsx` |

## 6. Data requirements

The data each module owns is drawn table by table in the [class diagram](diagrams/class-diagram.md#tables-each-module-owns). Rules that cut across it:

- Time-dependent states are worked out from timestamps and the Clock when read, never stored: whether a Poll is open, whether the Check-in window has closed at midnight, whether a Submission is Late.
- Attendance is one row per Session per Roster entry, overwritten so the latest action wins; Absent is the absence of a row or an unapproved Pending row after the window closed.
- Uploaded files are stored on disk under their content hash; their extracted text is stored in the database.
- The server stores the author of an anonymous Comment and the voter of every Vote, but no read model shows them to the Lecturer.

## 7. Gaps settled while writing

Five gaps found while writing this doc set were settled with the Lecturer-developer on 2026-11-26, and are written into the requirements above and into the [demo spec](https://github.com/ofeq-dev/class-connect/issues/20):

1. **Student screens for tier 3** (FR-SA-1): Session summaries and Assignments are lists on Today, each opening a plain sub-page. The tab bar stays at four.
2. **Who creates a Session's Topic** (FR-FB-1): Feedback works it out from the Course's Sessions and stores it on first use, so Course never calls Feedback.
3. **What Diagnostics shows for a device** (FR-LC-6): a 6-character device ID from the stored token hash.
4. **Transcripts without timestamps** (FR-SUM-1, FR-SUM-2): accepted with a warning; the outline has no times.
5. **Access to the Projector window** (FR-LC-7): an unguessable, replaceable per-Course link.

Nothing is open.

## 8. Traceability

| Brief feature | Requirements | Use cases |
|---|---|---|
| Automatic attendance + spreadsheet | FR-ID-*, FR-ATT-*, FR-LC-3, FR-LC-7 | UC-1 – UC-6 |
| Comments in real time / offline | FR-FB-1 – FR-FB-9, FR-LC-4 | UC-7, UC-8 |
| KISS Polls | FR-FB-10 – FR-FB-15, FR-LC-5 | UC-9, UC-10 |
| ML summary of a recording | FR-SUM-* | UC-11, UC-12 |
| Deep homework review with comparison | FR-HW-* | UC-13 – UC-17 |
| Simple smartphone web app | FR-SA-*, NFR-1, NFR-11 | UC-2, UC-3, UC-8, UC-10 |
| Works in this classroom, live demo | NFR-2 – NFR-4, NFR-9, NFR-10 | UC-5 |
