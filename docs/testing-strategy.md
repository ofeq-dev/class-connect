# Testing strategy

How Class Connect is tested, drawn from the seams fixed in [System architecture and components](https://github.com/ofeq-dev/class-connect/issues/10). Terms follow `GLOSSARY.md`.

## Principles

- **Test through interfaces, not internals.** Each feature module (Course, Attendance, Feedback, Summaries, Homework) is a deep module with a small set of operations. Its tests call those operations and check what they return and what the module's read models show afterwards. Tests never reach into a module's tables or private functions, so the module's internals can change without breaking them.
- **Fake only the injected seams.** The five infrastructure modules (LLM gateway, Jobs, Live events, Clock, File store) are passed into the feature modules. Feature tests pass in fakes for them, except Jobs, which is the real worker over the test's in-memory database (it is local and cheap, and a fake would duplicate its retry rules). Nothing else is mocked.
- **The database is real.** Every test gets a fresh SQLite database in memory (`better-sqlite3` `:memory:`), with the checked-in Drizzle migrations applied. There are no repository fakes: SQL constraints, such as one Vote per Poll per Roster entry, are part of the behaviour under test.
- **Time is the Clock.** States that depend on time (a Poll opening or closing on schedule, the Check-in window closing at midnight, a Late Submission, the Help match deadline) are worked out from the Clock when they are read. So tests set the fake Clock and read, rather than waiting.
- **Routes are thin, so end-to-end tests are few.** Routes only adapt HTTP to module operations. A small end-to-end suite checks that adapting: identity, cookies, the client IP header, Server-Sent Events. It doesn't repeat the module rules.
- **The test runner is Vitest**, which comes with the Vite toolchain the front end already uses. One `npm run check` runs the type check, the lint (including the import-boundary rule), and every test suite.

## The test harness

Shared test helpers live in `src/server/testing/`. They are the only place fakes are built.

| Seam | Fake | What a test can do with it |
|---|---|---|
| **Clock** | `FakeClock` | `set(instant)` and `advance(duration)`. The default is a fixed weekday morning. `now()` is the only time source any module reads. |
| **LLM gateway** | The scripted adapter (`LLM_ADAPTER=fake`) | Script a reply per `task`: a fixed result, a function of the input, an `LlmError` (timeout, every model failed, daily limit reached), or a reply that fails the schema. It records every call (task, input) for assertions. It checks scripted replies against the task's schema, so a test can't hand a module a shape the real gateway would reject. `embed` returns deterministic vectors made from the text, so text that is the same or nearly the same gives vectors that are similar. |
| **Jobs** | The real SQLite-backed worker, with its timer not started | `makeTestApp` returns it as `jobs`. `runDue()` runs, in order, the jobs whose `run_at` has passed on the fake Clock, with the real retry rules (3 attempts, then failed). A test makes a job fail by scripting its cause: an `LlmError` or a bad reply on the scripted gateway, or a rejecting `embed`. Tests read a job's status through the module's own read model (e.g. the review run view), or `jobs.read` / `jobs.tally`, never the `job` table. |
| **Live events** | `RecordingEvents` | Records each notice published, with its scope (Course and role). Tests assert on the notices sent, such as `{type: "poll.changed", id}`. They don't assert on transport. |
| **File store** | `MemoryFileStore` | Keeps bytes in a map under their content hash. Tests can preload fixture files: a short PDF, a VTT Transcript, a `.txt` Transcript. |

`makeTestApp(overrides?)` builds the whole module graph over a fresh database with these fakes. It returns the modules, the fakes, and the Hono app, so one helper serves both module tests and end-to-end tests. Builders (`aCourse()`, `aRoster(n)`, `aClaimedStudent()`, `anOpenSession()`, `anAssignmentWithCriteria()`) set up common states through the modules' own operations, never by inserting rows directly.

## Feature modules

Each module is tested through its own interface with the fakes above. The plans below list the behaviours each suite must pin down. They aren't a list of test cases.

### Course

Interface: `importRoster`, `claim`, `resetClaim`, `whoIs(token)`, and Session create / read / update / delete.

- **Roster import**: a CSV with name and student ID gives one Roster entry per row. Bad rows are reported, not silently dropped. Importing again doesn't duplicate existing student IDs. The Lecturer can add a single Student by hand.
- **Claim** (ADR 0002):
  - A claim by an unknown student ID is refused.
  - The confirm step returns the Roster name before the binding is made.
  - The first claim wins. A second claim of the same entry from another device is refused.
  - One device per Student and one Student per device: a device that has already claimed one entry can't claim another.
  - Only the device token's hash is stored. `whoIs` resolves the raw token and returns nothing for an unknown or reset token.
- **Claim reset**: it releases the binding at once, so the old token stops resolving and a new claim succeeds. It doesn't touch attendance history (Attendance owns attendance; checked by an Attendance test that uses Course).
- **Sessions**: each Session gets a unique QR code, `/s/<code>`. Its start and end times are stored, and deleting it removes the Session. Every Session shows a Topic (checked with Feedback).
- **Projector link**: `projectorCourse(secret)` resolves the Course's current link. A new link stops the old one resolving.

### Attendance

Interface: `openWindow(session, {ipv4, ipv6})`, `closeWindow`, `checkIn → Present | Pending`, `approveNetwork`, `mark`, `sheet`, `exportXlsx`, `isPresent`.

- **Block match** (ADR 0001):
  - An IPv4 address in the Lecturer's `/24`, or an IPv6 address in the Lecturer's `/64`, gives Present.
  - An address one block away gives Pending.
  - IPv4 is only compared with the Lecturer's IPv4, and IPv6 only with their IPv6. A window opened with only one address family still works.
  - IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are treated as IPv4.
- **Check-in window**:
  - A Check-in is refused when the window isn't open.
  - Reopening the window keeps earlier Check-ins and records the Lecturer's new addresses.
  - At midnight on the fake Clock the window reads as closed, with no job or timer needed.
- **Pending check-ins and Network approval**:
  - Approving a block turns every Pending check-in from it into Present, and later Check-ins from it in the same Session give Present.
  - Approval doesn't carry over: a Check-in from that block in a later Session gives Pending.
  - No number of Pending check-ins from one block approves it; only the Lecturer does.
  - When the window closes, Pending check-ins still unapproved read as Absent.
- **Manual marks**:
  - A Manual mark works whether the window is open or closed. The latest action wins, both ways (a Manual absent over a Check-in, and a Check-in over a Manual absent while the window is open).
  - Each Check-in record logs the Roster entry, the IP, the block and the device token.
- **Attendance sheet**:
  - Rows are every Roster entry, including unclaimed Students. Columns are Sessions in date order.
  - Each cell is Present, Manual or Absent.
  - The per-Student total counts Manual as attended. The per-Session headcount row is correct.
  - A Claim reset leaves the rows unchanged.
  - `exportXlsx` returns a file that, read back with the same xlsx library, matches `sheet`.
- **Live events**: every Check-in, approval and mark publishes an attendance notice to the Lecturer scope. A Student never receives notices about other Students.

### Feedback

Interface: `comment`, `setStatus`, `listComments`, `createPoll`, `openPoll`, `closePoll`, `vote`, `results(poll, viewer)`.

- **Topics**: General exists for every Course, and each Session has its own Topic, listed before anything uses it and stored the first time a Comment or Poll does. The Lecturer can add, rename and archive named Topics.
- **Comments**:
  - Only a claimed Student can comment.
  - On a Session Topic, the before / during / after tag comes from the fake Clock against the Session's start and end, including the boundaries. Other Topics carry a timestamp only.
  - The presence note comes from `isPresent`, and anonymous Comments carry it too.
  - An anonymous Comment never shows its author in any Lecturer read model, though the stored Roster entry is kept.
  - A Student sees only their own Comments.
  - A Student can delete a Comment only while it is New.
  - Statuses (New / Pinned / Addressed / Ignored) move freely. A Pinned Comment appears at the top of every later Session's view until it is Addressed.
  - Every filter works: Topic, Student, Anonymous, status, before / during / after.
- **Polls**:
  - A Poll has 2–6 options, and any other number is refused.
  - A Poll is created as a draft. Scheduled open and close times are worked out from the fake Clock, and a manual open or close overrides them (the latest action wins).
  - A closed Poll can't be reopened. Several Polls can be open at once.
- **Votes**:
  - There is one Vote per Roster entry, which the Student can change while the Poll is open. A Vote on a closed Poll is refused.
  - `results` for the Lecturer gives live totals with no voter identities.
  - `results` for a Student gives nothing until the Poll closes, then the totals.
- **Live events**: a new Comment and a status change notify the Lecturer. A Poll that opens, closes or gets a Vote notifies the right scope: Students when it opens or closes, only the Lecturer when it gets a Vote.

### Summaries

Interface: `uploadTranscript`, `generate`, `saveEdit`, `restore`, `publish`, `forStudent(session, language)`.

- **Transcripts**: VTT cue numbers are stripped and timestamps kept. A `.txt` upload and pasted text both work. A Transcript with no timestamps is accepted with a warning, and the scripted summary's outline then has no times. A Session has at most one Session summary.
- **Generate**:
  - `generate` queues a job.
  - `jobs.runDue()` calls the scripted gateway once, with the summary task. The result has the four sections and becomes version 1, marked as made by AI.
  - A scripted `LlmError` leaves the summary failed with a retryable error, and Retry queues the job again.
  - Regenerating adds a version. It never overwrites one.
  - Notices are published for "Summarising…", done and failed.
- **Versions**: each saved edit adds a version marked as made by the Lecturer. Restoring copies the old version as the newest. Deleting the summary deletes its history.
- **Publishing**:
  - Students see nothing before publishing, and only the published version after it, even after later edits.
  - Publishing queues one translation job per Course language, made from the published version.
  - Publishing again regenerates the translations, replacing any translation edits.
- **`forStudent`**:
  - It returns the requested language when that translation exists, and otherwise the source language.
  - A Student without a Claim on the Course gets nothing.

### Homework

Interface: `setAssignment`, `submit`, `startReviewRun`, `editReview`, `release`, `requestHelp`, `offerHelp`, `matchNow`, and the Lecturer and Student read models.

- **Assignments**: an Assignment has 3–5 Criteria, and any other number is refused.
- **Submissions**:
  - Pasted text and a fixture PDF are both accepted. The PDF's text is extracted and stored.
  - A Student can replace their Submission until the due date. After it, a Submission is accepted and reads as Late, worked out from the fake Clock.
- **Review run**:
  - `startReviewRun` queues one `review.submission` job per Submission, then `review.compare`, then `review.classSummary`.
  - Job progress is published as `job.progress` notices.
  - A Submission whose scripted reply fails is retried up to 3 times, then shown as failed with a per-Submission Retry. The other Submissions are unaffected.
- **Comparison**:
  - Near-copies give a similarity pair with both signals and the overlapping passages. Unrelated texts don't.
  - A pair changes no level and doesn't block Release.
  - Student aggregates are hidden below 5 Submissions and never include names or text.
- **Review and Release**:
  - The Lecturer can edit any draft Review.
  - Students see nothing before Release, then their own Review and the class summary.
  - A Late Submission reviewed after Release is released on its own, and the class summary and Help matches stay as they were.
- **Help matching**, the most rule-heavy logic. It runs with no LLM and gets table-style tests:
  - A Student can make a Help request only for a Criterion where they reached Not yet or Partly. A Student can offer to be a Helper only for a Criterion where they reached Secure. Both open only after Release.
  - Not yet requests are matched before Partly. Ties go to whoever asked first.
  - Each request goes to the Helper with the fewest matches so far, and no Helper gets more than 2 matches per Criterion.
  - An unmatched request reads as "No Helper this time — ask your Lecturer", and an unmatched offer is thanked.
  - No read model shows anyone's level to another Student. Names appear only to the two matched Students.
  - Matching runs when the fake Clock passes the match deadline and `runDue()` runs, or when `matchNow` is called. Matching twice does nothing more.

## Infrastructure modules

These are tested through their own interfaces, against the real thing where it is local and cheap, and against a stub only at the process edge.

| Module | Tested through | Plan |
|---|---|---|
| **LLM gateway** | `generate` / `embed` with the OpenRouter adapter over a stubbed `fetch` and the fake Clock | It tries the fallback list in order. A per-task timeout counts as a failure and moves to the next model. A reply that fails the schema gets one fix-up retry, then an `LlmError`. Only one call runs at a time, and at most ~15 a minute (checked by advancing the fake Clock). Each call adds to `llm_usage`, and reaching 1000 a day returns the limit error without calling `fetch`. The scripted adapter gets a small contract test that the same task schemas apply to it. |
| **Jobs** | The real SQLite-backed worker over an in-memory database and the fake Clock | A job runs at or after `run_at` and never before. A failed job is retried up to its attempt limit with its error recorded. Progress updates are saved. Jobs still `running` after a simulated restart go back to `queued` and run again. A job interrupted before `complete` leaves nothing written, and one that completed is never run again. Attempts count when a job is claimed, so a job interrupted 3 times ends `failed`. Review-run progress is counted from job rows. Discarding jobs by kind and payload deletes them whatever their status, so a queued one never runs. The "next event" timer wakes at the earliest scheduled moment and only publishes notices or queues jobs. |
| **Live events** | The in-process bus and the SSE writer | A notice reaches only subscribers in its Course and role scope. A subscriber that disconnects is removed. The writer sends a heartbeat at the configured interval (~25 s, shortened in tests). |
| **Clock** | Nothing to test | The system Clock is a one-line adapter, and `FakeClock` is exercised by every other suite. |
| **File store** | The disk adapter in a temporary folder | A file is stored under its content hash, so the same bytes stored twice are kept once. Reading a stored file returns the same bytes. Reading a missing hash returns not found. |

## End to end through HTTP and SSE

A small suite starts the real Hono app from `makeTestApp` on an ephemeral port. It talks to the app with `fetch` and an SSE reader. These tests check the HTTP and SSE adaptation, not the module rules.

- **Lecturer identity**: a wrong password is refused. The right one sets a signed session cookie. Lecturer routes refuse requests without that cookie, and Student routes don't accept it as a Student.
- **Student identity**:
  - Claiming sets the device-token cookie with `httpOnly`, `Secure`, `SameSite=Lax` and a 400-day max age.
  - Each visit refreshes it.
  - Requests with an unknown token are treated as unclaimed.
- **Check-in by QR code**:
  - Loading `/s/<code>` with a claimed cookie checks the Student in with no further request.
  - The client IP is read from `CF-Connecting-IP`, which tests set to put a Student on or off the Classroom network.
  - An unclaimed phone goes through the claim and then the Check-in in one flow.
- **The demo's main path over SSE**:
  - The Lecturer and two Students each open a stream.
  - The Lecturer opens the window, one Student checks in on-network and the other off-network, and the Lecturer approves the second Student's network.
  - The Lecturer opens a Poll and the Students vote, then the Lecturer closes it.
  - The test asserts the order and scope of the notices each stream receives, and that refetching after each notice gives the expected state.
- **Reconnect**: a stream that drops and reconnects gets no backlog. The client contract (refetch everything after a reconnect) is covered by the client test below.
- **Heartbeat**: an idle stream receives a heartbeat within the configured interval.
- **Projector window**: the per-Course link opens it with no sign-in; an old link stops working after a new one is made.
- **Downloads**: the Attendance sheet export returns an xlsx with the right content type and file name.
- **Boundaries**: the app listens only on `127.0.0.1` (checked from the server config). A route can't reach a module's internals, which the import-boundary lint enforces rather than a test.

**Client.** The front end gets unit tests only where it holds logic of its own: the table that maps each notice type to TanStack Query keys (every notice type the server publishes has an entry, and a reconnect invalidates everything), the Markdown preview (`marked` + `DOMPurify` removes script), and each rendered block's text direction (right-to-left text, timestamps left-to-right). Screens are checked by hand in the rehearsal, not by browser automation.

## Rehearsing the live demo

The demo runs live in class on classmates' phones, and there is no fallback host (ADR 0003), so it is rehearsed end to end before class.

1. **Rehearse with the fake LLM.** Run the production build on the home server, behind the tunnel at `cc.ofeq.dev`, with `LLM_ADAPTER=fake`. The scripted adapter loads canned replies per task from fixtures: a Session summary, its translations, Reviews, a class summary. Every LLM step then returns at once and uses none of the 1000 requests a day. Seed a demo Course with a Roster, today's Session, a Transcript and a few Submissions.
2. **Walk the demo script on real phones**, at least one iPhone (Safari) and one Android phone (Chrome), plus the Lecturer laptop:
   - Scan the QR code with the camera app; the phone claims, then checks in.
   - Check in once from mobile data, so it shows as a Pending check-in, then approve that network.
   - Send a quick-reaction Comment and undo it.
   - Open a Poll, vote, close it, and see the results on the phones.
   - Generate and publish a Session summary, then switch its language.
   - Run a review run, then Release, a Help request and Match now.
   - Download the Attendance sheet.
   - Watch the Lecturer console update without reloading. Leave a phone idle for two minutes and check that its stream survives (the heartbeat through Cloudflare).
3. **One real-LLM dry run** the day before class, with the OpenRouter adapter. Summarise the ~5-minute Transcript clip, and run a small review run, to check that the fallback list and timeouts hold against today's free models. Make the 90-minute Session summary before class as planned.
4. **On the day:** switch back to the real adapter, check the `llm_usage` count shown in the console, and confirm the nightly backup ran.

The block-match rule in the rehearsal depends on the real classroom network, measured in [Measure the classroom Wi-Fi public IPs](https://github.com/ofeq-dev/class-connect/issues/12): on `Ariel-University`, phones and laptops leave through different addresses in one `/24`, so the rule holds. The rehearsal at home uses the home network as the Classroom network. Before the demo, the Lecturer opens the window on the classroom Wi-Fi, not on mobile data.

## Summary of coverage

| Layer | Runs against | Fakes |
|---|---|---|
| Feature module tests | Module interface + in-memory SQLite (and the real Jobs worker) | Clock, LLM gateway, Live events, File store |
| Infrastructure tests | Module interface + real local resource | `fetch` (LLM gateway only), Clock |
| End-to-end tests | Hono app on an ephemeral port, HTTP + SSE | Same as feature tests |
| Client unit tests | Pure functions | None |
| Rehearsal | Production build on `cc.ofeq.dev`, real phones | LLM gateway (`LLM_ADAPTER=fake`), then one real run |
