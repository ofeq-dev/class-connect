# Sequence diagrams

Four flows through the modules in the [class diagram](class-diagram.md), drawn from [System architecture and components](https://github.com/ofeq-dev/class-connect/issues/10). Terms follow [`GLOSSARY.md`](../../GLOSSARY.md).

Conventions in every diagram:

- **Routes** are the thin Hono adapters; they resolve the caller with `Course.whoIs(token)` and pass the result on. That lookup is left out after the first diagram.
- **Live events** carry change notices only (`{type, id}`), never data. On a notice, the client refetches the TanStack Query keys mapped to that type. Every page also refetches everything after its SSE stream reconnects.
- **Worker** is the one in-process worker draining the durable `job` table. The **next-event timer** wakes at the next scheduled moment and only sends notices or queues jobs; it never changes state.
- Scheduled moments (Poll open or close, Check-in window close) are not `job` rows. The timer asks each module for its `nextMoment(after)` and recomputes after every wake, and whenever a module reports a schedule change. Settled in [Open seams found while drawing the diagrams](https://github.com/ofeq-dev/class-connect/issues/15).

## 1. Claim, then Check-in

Covers the Check-in window opening, a first-time phone claiming its Roster entry and checking in in one flow, a Pending check-in, and Network approval by the Lecturer's tap for this Session.

```mermaid
sequenceDiagram
  autonumber
  actor L as Lecturer console
  participant IP as ipify (api4 / api6)
  actor S as Student phone
  participant R as Routes
  participant C as Course
  participant A as Attendance
  participant E as Live events

  Note over L,E: Lecturer opens the Check-in window
  L->>IP: GET own IPv4 and IPv6
  IP-->>L: ipv4, ipv6 (either may be missing)
  L->>R: POST /sessions/:id/window {ipv4, ipv6}
  R->>A: openWindow(session, ipv4, ipv6)
  A->>A: insert check_in_window row
  A->>E: publish(course, lecturer, attendance.changed)

  Note over S,E: Student scans the Session QR code
  S->>R: GET https://cc.ofeq.dev/s/:code (page loads, no device cookie)
  R->>C: readSession(code)
  C-->>R: session
  R->>C: whoIs(no token)
  C-->>R: unknown
  R-->>S: claim needed
  S->>R: POST claim lookup {studentId}
  R->>C: findRosterEntry(course, studentId)
  C-->>R: entry name
  R-->>S: "You are Dana Levi. Correct?"
  S->>R: POST claim {studentId} (confirmed)
  R->>C: claim(course, studentId, new device token)
  alt entry already claimed
    C-->>R: refused (first claim wins)
    R-->>S: "Already claimed — ask your Lecturer"
  else unclaimed
    C->>C: store token hash, claimed_at
    C-->>R: rosterEntry
    R-->>S: Set-Cookie device token (httpOnly, Secure, SameSite=Lax, 400 days)
  end

  Note over S,E: Check-in fires automatically on the same page
  S->>R: POST /s/:code/check-in
  R->>C: whoIs(token)
  C-->>R: rosterEntry (cookie refreshed)
  R->>A: checkIn(session, rosterEntry, CF-Connecting-IP, deviceToken)
  A->>A: read approved_network rows for this Session
  alt window closed (by Lecturer or past midnight)
    A-->>R: refused
    R-->>S: "Check-in is closed"
  else IP in Lecturer's /24 or /64, or in a block approved for this Session
    A->>A: upsert attendance = Present, with ip, block, token
    A->>E: publish(course, lecturer, attendance.changed)
    A-->>R: Present
    R-->>S: "You're checked in"
  else any other network
    A->>A: upsert attendance = Pending, with ip, block, token
    A->>E: publish(course, lecturer, attendance.changed)
    A-->>R: Pending
    R-->>S: "Checked in — waiting for your Lecturer to confirm"
  end

  Note over L,E: Network approval by one tap, for this Session only
  E-->>L: attendance.changed → refetch, Pending grouped by block
  L->>R: POST approve network {block}
  R->>A: approveNetwork(session, block)
  A->>A: insert approved_network (session, block)
  A->>A: that block's Pending rows for this Session → Present
  A->>E: publish(course, lecturer, attendance.changed)
  A->>E: publish(course, student, attendance.changed)
  E-->>S: attendance.changed → refetch Today: "You're checked in"

  Note over L,A: Pending rows left when the window closes read as Absent. Manual marks work any time.
```

## 2. A Poll opens and Votes arrive live

```mermaid
sequenceDiagram
  autonumber
  actor L as Lecturer console
  actor S as Student phone
  participant R as Routes
  participant F as Feedback
  participant K as Clock
  participant T as Next-event timer
  participant E as Live events

  L->>R: POST poll {topic, question, 2–6 options, optional schedule}
  R->>F: createPoll(topic, question, options, schedule)
  F-->>R: draft Poll

  alt opened by hand
    L->>R: POST /polls/:id/open
    R->>F: openPoll(poll)
    F->>F: set opened_at
    F->>E: publish(course, all, poll.changed)
  else opened on schedule
    T->>F: nextMoment(now)
    T->>K: wake at scheduled_open_at
    T->>E: publish(course, all, poll.changed)
    Note over F,K: no write: the Poll reads as open because now ≥ scheduled_open_at
  end

  E-->>S: poll.changed → refetch Polls
  S->>S: badge on the Polls tab + banner (never jumps)
  E-->>L: poll.changed → refetch results

  loop each Vote
    S->>R: POST /polls/:id/vote {option}
    R->>F: vote(poll, rosterEntry, option)
    F->>K: now()
    alt Poll is open
      F->>F: upsert vote (one per Roster entry, latest wins)
      F->>E: publish(course, lecturer, poll.changed)
      F-->>R: ok
      R-->>S: your choice is marked
      E-->>L: poll.changed
      L->>R: GET /polls/:id/results
      R->>F: results(poll, lecturer)
      F-->>L: live totals (no voter names)
    else Poll is closed
      F-->>R: refused
      R-->>S: "This Poll has closed"
    end
  end

  alt closed by hand
    L->>R: POST /polls/:id/close
    R->>F: closePoll(poll)
    F->>F: set closed_at
    F->>E: publish(course, all, poll.changed)
  else closed on schedule
    T->>E: publish(course, all, poll.changed) at open + close_after_minutes
    Note over F,K: no write: the Poll reads as closed because now ≥ its open time + close_after_minutes
  end
  E-->>S: poll.changed
  S->>R: GET /polls/:id/results
  R->>F: results(poll, student)
  F-->>S: totals, now that the Poll is closed
```

## 3. Transcript to a published Session summary

```mermaid
sequenceDiagram
  autonumber
  actor L as Lecturer console
  actor S as Student phone
  participant R as Routes
  participant SM as Summaries
  participant FS as File store
  participant J as Jobs
  participant W as Worker
  participant G as LLM gateway
  participant OR as OpenRouter
  participant E as Live events

  L->>R: upload Transcript (.vtt / .txt or pasted text)
  R->>SM: uploadTranscript(session, file)
  SM->>FS: put(bytes)
  FS-->>SM: content hash
  SM->>SM: strip VTT cue numbers, keep timestamps, store text
  L->>R: POST generate
  R->>SM: generate(session)
  SM->>J: enqueue(summary.generate, {session})
  SM->>E: publish(course, lecturer, summary.changed)
  E-->>L: "Summarising…"

  W->>J: next due job
  J-->>W: summary.generate
  W->>SM: handler(job)
  SM->>G: generate({task: summarise, input: transcript, schema})
  loop fallback list of free models, until one returns a valid reply
    G->>OR: chat completion (3-minute timeout)
    OR-->>G: reply, error or timeout
    opt reply fails the schema
      G->>OR: one retry asking the model to fix its reply
    end
  end
  G->>G: count against llm_usage (1000/day)
  alt a model succeeded
    G-->>SM: overview, timestamped outline, key points, review questions
    SM->>SM: new summary_version (author AI)
    SM->>E: publish(course, lecturer, summary.changed)
    E-->>L: refetch → draft in the Markdown editor
  else every model failed, or daily limit reached
    G-->>SM: LlmError
    SM->>J: mark job failed with error
    SM->>E: publish(course, lecturer, summary.changed)
    E-->>L: error + Retry (Retry calls generate again)
  end

  L->>R: save edit (Markdown)
  R->>SM: saveEdit(summary, markdown, source language)
  SM->>SM: new summary_version (author Lecturer)

  L->>R: publish version
  R->>SM: publish(summary, version)
  SM->>SM: point summary at that version
  loop each extra language set on the Course
    SM->>J: enqueue(summary.translate, {summary, language})
  end
  SM->>E: publish(course, student, summary.changed)
  E-->>S: refetch → source-language summary visible

  loop each translate job
    W->>SM: handler(job)
    SM->>G: generate({task: translate, input: published version, schema})
    G-->>SM: translated Markdown (timestamps unchanged)
    SM->>SM: upsert summary_translation
    SM->>E: publish(course, all, summary.changed)
  end
  S->>R: GET summary?lang=browser language
  R->>SM: forStudent(session, language)
  SM-->>S: translation if present, else source language
```

## 4. Homework review run through Release and Help matching

```mermaid
sequenceDiagram
  autonumber
  actor L as Lecturer console
  actor SA as Student A (Not yet)
  actor SB as Student B (Secure)
  participant R as Routes
  participant H as Homework
  participant J as Jobs
  participant W as Worker
  participant G as LLM gateway
  participant E as Live events

  L->>R: start review run
  R->>H: startReviewRun(assignment)
  loop each Submission
    H->>J: enqueue(review.submission, {submission})
  end

  loop each review.submission job
    W->>H: handler(job)
    H->>G: generate({task: reviewSubmission, input: Criteria + Submission text, schema})
    alt valid Review
      G-->>H: level, evidence quote, feedback per Criterion
      H->>H: draft review + review_level rows
    else LlmError
      G-->>H: LlmError
      H->>J: retry (up to 3 attempts), then failed
    end
    H->>J: progress(run, done, total)
    J->>E: publish(course, lecturer, job.progress {done, total})
    E-->>L: progress bar, Retry on failed Submissions
  end

  Note over H,J: the handler that settles the run's last job (succeeded, or failed after 3 attempts)<br/>finds no unsettled jobs in the same transaction and queues compare
  H->>J: enqueue(review.compare)
  W->>H: handler(review.compare)
  H->>H: fingerprints over every Submission
  H->>G: embed(all Submission texts) — one batched call
  G-->>H: vectors
  H->>H: similarity_pair rows above threshold (Lecturer only)
  H->>J: enqueue(review.classSummary)
  W->>H: handler(review.classSummary)
  H->>G: generate({task: classSummary, input: all Reviews, schema})
  G-->>H: counts per Criterion, common mistakes
  H->>E: publish(course, lecturer, homework.changed)

  opt Lecturer retries a failed Submission
    L->>R: Retry
    R->>H: retryReview(submission)
    H->>J: enqueue(review.submission, {submission})
    Note over H,J: on success the same settle check re-queues review.compare, then review.classSummary
  end

  L->>R: edit any draft Review
  R->>H: editReview(review, levels)

  L->>R: Release {match deadline, default Release + 2 days}
  R->>H: release(assignment, matchDeadline)
  H->>H: refuse while any on-time Submission has no Review (Retry or write it by hand)
  H->>H: set released_at on assignment and its Reviews
  H->>J: enqueue(help.match, {assignment}, runAt = matchDeadline)
  H->>E: publish(course, student, homework.changed)
  E-->>SA: refetch → own Review + class summary
  E-->>SB: refetch → own Review + class summary

  SA->>R: ask for help on Q2
  R->>H: requestHelp(Q2, A)
  H->>H: check A is Not yet / Partly on Q2, store help_request
  SB->>R: offer help on Q2
  R->>H: offerHelp(Q2, B)
  H->>H: check B is Secure on Q2, store help_offer
  H->>E: publish(course, lecturer, homework.changed)

  alt Lecturer presses Match now
    L->>R: Match now
    R->>H: matchNow(assignment)
    H->>J: enqueue(help.match, {assignment}, runAt = now)
    Note over H,J: the deadline job stays queued and no-ops later because matched_at is set
  else deadline passes
    Note over J,W: the next-event timer wakes at run_at, the worker picks the job up
  end
  W->>H: handler(help.match)
  H->>H: one pass: Not yet before Partly, earliest first, each to the Helper with fewest matches (max 2 per Criterion)
  H->>H: store help_match rows, set matched_at
  H->>E: publish(course, all, homework.changed)
  E-->>SA: "You and B are paired for Q2"
  E-->>SB: "You and A are paired for Q2"
  Note over SA,SB: unmatched request: "No Helper this time — ask your Lecturer". Unmatched offer: thanked.<br/>Help requests and offers close for good once matched_at is set.

  opt Late Submission after Release
    Note over H,G: its own review.submission job, then its fingerprints and embedding join similarity.<br/>The released class summary stays frozen
    L->>R: release this Review
    R->>H: releaseReview(review)
    H->>E: publish(course, student, homework.changed)
  end
```
