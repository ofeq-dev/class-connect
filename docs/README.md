# Class Connect: problem and scope

Class Connect is a set of simple, phone-first teaching tools for a live Course: attendance, real-time Comments, Polls, Session summaries and homework Reviews. Students use a web app on their own phones, with nothing to install. The Lecturer uses a console on a laptop.

Terms in **bold capitals** (Course, Session, Check-in, …) are defined in [`GLOSSARY.md`](../GLOSSARY.md) and used with that meaning throughout this doc set.

## The problem

The online teaching tools in use today don't deliver. They are heavy, they split one Course across several products, and they aren't built for LLMs. A Lecturer who wants to know who came, what the room didn't follow, what a Session covered and how an Assignment went has to piece the answers together by hand.

The assignment asks for a better, simpler, LLM-ready set of tools that:

1. lets Students record their attendance automatically, or as simply as possible, and lets the Lecturer check it and get an online and downloadable spreadsheet of it. **This is the main feature.**
2. lets Students comment and raise suggestions in real time and afterwards;
3. lets the Lecturer run quick, on-the-spot Polls about the current material;
4. gives the Lecturer an ML summary of a recorded Session;
5. gives Students and the Lecturer a deep LLM review of homework, including comparison with other Students' work.

It must work in this classroom, shown in a real live demo, and the Student side must be a simple web app on a phone. Integration with Zoom, Meet or Google Classroom is not required.

## What Class Connect does

| Brief feature | Class Connect | Priority |
|---|---|---|
| Automatic attendance + spreadsheet | **Check-in** by scanning the Session's QR code. It counts at once from the Classroom network, and is a **Pending check-in** from any other network until a **Network approval**. The Lecturer sees attendance live, can **Manual mark** any Student, and downloads the per-Course **Attendance sheet** as xlsx. | 1, polished |
| Comments and suggestions | **Comments** on a **Topic** (General, each Session, or a named item such as "Assignment 2"), named or anonymous, any time; one-tap quick reactions during a Session. Private to the Lecturer, who pins, addresses or ignores them. | 2, simple |
| On-the-spot polls | Single-choice **Polls** with 2–6 options, opened and closed by hand or on a schedule; one **Vote** per Student, results shown to Students once the Poll closes. | 2, simple |
| ML summary of a recording | A **Session summary** generated from the Session's Zoom **Transcript**: overview, timestamped outline, key points, review questions. The Lecturer edits and publishes it, with automatic translations. | 3, minimal UI |
| Deep review with comparison | Each **Submission** gets a **Review** against the **Assignment**'s 3–5 **Criteria** (Not yet / Partly / Secure). Similarity between Submissions goes to the Lecturer only, anonymised class aggregates go to Students, and double-blind **Help matches** pair a Student who needs help on a Criterion with a classmate who is Secure on it. | 3, minimal UI |

The two key departures from the brief's examples are recorded as decisions:

- **No photo head count.** A head count gives a number, not names, and means processing photos of Students. A QR code plus a network check gives per-Student attendance with no ML model. See [ADR 0001](adr/0001-qr-and-network-check-in-instead-of-photo-count.md).
- **No Student accounts.** A Student **Claims** their **Roster** entry once by student ID, which binds them to their phone. See [ADR 0002](adr/0002-no-student-accounts-roster-claim-and-device-binding.md).

"Offline" in the brief is read as **asynchronous** (Comments can be sent after the Session) and **downloadable** (the xlsx Attendance sheet), not as an app that works without a connection.

## Scope

### In scope

- One Lecturer, several Courses, each with a Roster imported from CSV.
- The Student phone web app: Check-in, Comments, Polls, and their own Comments.
- The Lecturer console for a live Session (attendance, Comment inbox, Poll control, Roster) and a public Projector window.
- Session summaries from a `.vtt` or `.txt` Transcript, with version history, publishing and per-Course translations.
- Assignments, Submissions (text or PDF), Reviews, Release, similarity for the Lecturer, class aggregates for Students, and Help matching.
- Hosting on the developer's home server behind a Cloudflare Tunnel at `cc.ofeq.dev`, using free OpenRouter models ([ADR 0003](adr/0003-home-server-behind-cloudflare-tunnel.md)).
- A live demo in the classroom on classmates' phones.

### Out of scope

- Photo head count (replaced by QR code + network Check-in; ADR 0001).
- Offline-first operation with later sync.
- Zoom / Meet / Google Classroom integration (per the brief).
- A rotating QR code (the network check already defeats forwarded links).
- Transcribing uploaded recordings with Whisper (v2; the demo uses Zoom VTT Transcripts).
- A seating plan driven by homework comparison (v2).
- Student Comment threads, free-text Polls with an LLM summary, Session kinds (lecture / recitation), a TA role, aligning a Course taught several times a week, and present/absent splits of Poll results (all v2).
- AI review or prompted revision of a Session summary (v3), Telegram notifications (v2), and rich-text summary editing (v2).
- More than one Lecturer account (v2), Student passwords, and email verification.
- Backing up uploaded files (`FILES_DIR`: Transcripts and Submissions) alongside the database (v2; the nightly and pre-deploy backups copy the database only).

## Constraints

- **Solo developer, built by AI agents.** Architecture comes first; the code reuses open-source modules wherever it can.
- **Free LLMs only.** OpenRouter free models, with 10 credits bought so the limit is 1000 requests a day.
- **One machine.** No fallback host: if the home server is down during the demo, the demo is down (ADR 0003).
- **The classroom network.** The campus Wi-Fi (`Ariel-University`) sends traffic out through a pool of addresses in one `/24` and has no IPv6, so Check-in is decided by the IPv4 `/24` ([measured](https://github.com/ofeq-dev/class-connect/issues/12)).

## The doc set

| Document | What it covers |
|---|---|
| [Statement of Work](statement-of-work.md) | Deliverables, approach, milestones, roles, assumptions and risks |
| [Software Requirements Specification](srs.md) | Functional and non-functional requirements, numbered for tracing |
| [Use cases](use-cases.md) | Actors, the use-case map and the main client stories |
| [Components](components.md) | Modules, their interfaces and seams, real time, jobs, data and deployment |
| [Class diagram](diagrams/class-diagram.md) | Module interfaces and the tables each module owns |
| [Sequence diagrams](diagrams/sequence-diagrams.md) | Claim → Check-in, a live Poll, Transcript → Session summary, review run → Release → Help matching |
| [Testing strategy](testing-strategy.md) | What each module is tested through, end-to-end coverage and the demo rehearsal |
| [`GLOSSARY.md`](../GLOSSARY.md) | The project's vocabulary |
| [`adr/`](adr/) | Architecture decision records |

Every decision behind these documents was made on the [wayfinder map](https://github.com/ofeq-dev/class-connect/issues/1) and its linked tickets.
