# Class diagram

Drawn from [System architecture and components](https://github.com/ofeq-dev/class-connect/issues/10). Terms follow [`GLOSSARY.md`](../../GLOSSARY.md).

The server is one Hono process. HTTP routes are thin adapters: they call only the module interfaces below. Five **feature modules** own all domain state. Five **infrastructure modules** are injected into them, so tests can pass in fakes.

Operations marked **‡** are not named in the architecture resolution. Each module needs one to do what was decided, so they are drawn here and listed in [Open seams found while drawing the diagrams](https://github.com/ofeq-dev/class-connect/issues/15).

## Modules and their interfaces

```mermaid
classDiagram
  direction TB

  class Routes {
    <<adapter>>
    Hono JSON API, SSE streams, built front end
  }

  namespace Feature {
    class Course {
      <<module>>
      +importRoster(course, csv) RosterEntry[]
      +addRosterEntry(course, studentId, name) RosterEntry ‡
      +findRosterEntry(course, studentId) RosterEntry ‡
      +claim(course, studentId, deviceToken) RosterEntry
      +resetClaim(rosterEntry)
      +whoIs(token) Viewer
      +createSession(course, date, start, end) Session
      +readSession(idOrQrCode) Session
      +updateSession(session, changes)
      +deleteSession(session)
    }
    class Attendance {
      <<module>>
      +openWindow(session, ipv4, ipv6)
      +closeWindow(session)
      +checkIn(session, rosterEntry, ip, deviceToken) Present or Pending
      +approveNetwork(session, block)
      +mark(session, rosterEntry, present)
      +sheet(course) AttendanceSheet
      +exportXlsx(course) Bytes
      +isPresent(session, rosterEntry) boolean
    }
    class Feedback {
      <<module>>
      +addTopic(course, name) Topic ‡
      +renameTopic(topic, name) ‡
      +archiveTopic(topic) ‡
      +comment(topic, author, text, anonymous) Comment
      +setStatus(comment, status)
      +listComments(filter) Comment[]
      +createPoll(topic, question, options, schedule) Poll
      +openPoll(poll)
      +closePoll(poll)
      +vote(poll, rosterEntry, option)
      +results(poll, viewer) PollResults
    }
    class Summaries {
      <<module>>
      +uploadTranscript(session, fileOrText) Transcript
      +generate(session)
      +saveEdit(summary, markdown, language)
      +restore(version)
      +publish(summary, version)
      +forStudent(session, language) PublishedSummary
    }
    class Homework {
      <<module>>
      +setAssignment(course, assignment, criteria) Assignment
      +submit(assignment, rosterEntry, textOrPdf) Submission
      +startReviewRun(assignment)
      +retryReview(submission) ‡
      +editReview(review, levels)
      +release(assignment, matchDeadline)
      +requestHelp(criterion, rosterEntry)
      +offerHelp(criterion, rosterEntry)
      +matchNow(assignment)
      +lecturerView(assignment) LecturerAssignmentView
      +studentView(assignment, rosterEntry) StudentAssignmentView
    }
  }

  namespace Infrastructure {
    class LlmGateway {
      <<interface>>
      +generate(task, input, schema) Result~T, LlmError~
      +embed(texts) Vector[]
      +usageToday() count
    }
    class Jobs {
      <<interface>>
      +enqueue(kind, payload, runAt) Job
      +register(kind, handler)
      +progress(job, done, total)
      +retry(job)
    }
    class LiveEvents {
      <<interface>>
      +publish(course, audience, notice)
      +subscribe(course, role) Stream
    }
    class Clock {
      <<interface>>
      +now() Instant
    }
    class FileStore {
      <<interface>>
      +put(bytes) contentHash
      +get(contentHash) Bytes
    }
  }

  Routes --> Course
  Routes --> Attendance
  Routes --> Feedback
  Routes --> Summaries
  Routes --> Homework
  Routes --> LiveEvents : subscribe per page

  Attendance --> Course : Sessions
  Feedback --> Course : Roster, Sessions
  Feedback --> Attendance : isPresent for presence notes
  Summaries --> Course : Sessions, translation languages
  Homework --> Course : Roster

  Course ..> Clock
  Attendance ..> Clock
  Attendance ..> LiveEvents
  Feedback ..> Clock
  Feedback ..> LiveEvents
  Summaries ..> LlmGateway
  Summaries ..> Jobs
  Summaries ..> LiveEvents
  Summaries ..> FileStore
  Homework ..> LlmGateway
  Homework ..> Jobs
  Homework ..> LiveEvents
  Homework ..> FileStore
  Homework ..> Clock
```

Solid arrows are calls between modules; dotted arrows are injected infrastructure. A lint rule on imports keeps a module out of another module's folder, so every solid arrow goes through the target's interface.

### Infrastructure adapters

| Interface | Real adapter | Test / rehearsal adapter |
|---|---|---|
| LLM gateway | OpenRouter: fallback list of free models, per-task timeouts, schema validation with one fix-up retry, one call at a time (~15/min), `llm_usage` count against 1000/day | scripted fake (`LLM_ADAPTER=fake`) |
| Jobs | durable `job` table worked by one in-process worker, plus the next-event timer | run-inline fake |
| Live events | in-process bus feeding one SSE stream per page (Course × role), heartbeat ~25 s | recording fake |
| Clock | system time | settable fake |
| File store | files on disk under their content hash | in-memory map |

LLM prompts are **task** definitions that live in each feature module (for example `summarise`, `translate`, `reviewSubmission`, `classSummary`, `draftCriteria`) and are passed to `LlmGateway.generate`.

## Tables each module owns

Drizzle over SQLite. A table belongs to exactly one module; other modules reach its data only through the owner's interface. Tables owned elsewhere are shown with their owner as the stereotype.

### Course

```mermaid
classDiagram
  direction LR
  class lecturer {
    <<table>>
    id
    name
  }
  class course {
    <<table>>
    id
    lecturer_id
    name
    translation_languages
  }
  class roster_entry {
    <<table>>
    id
    course_id
    student_id
    name
    device_token_hash
    claimed_at
  }
  class session {
    <<table>>
    id
    course_id
    date
    start
    end
    qr_code
  }
  lecturer "1" --> "*" course
  course "1" --> "*" roster_entry
  course "1" --> "*" session
```

The Lecturer's password hash lives in server config, not in `lecturer`. A Claim reset clears `device_token_hash` and `claimed_at`; it never touches attendance.

### Attendance

```mermaid
classDiagram
  direction LR
  class session {
    <<Course>>
  }
  class roster_entry {
    <<Course>>
  }
  class check_in_window {
    <<table>>
    id
    session_id
    opened_at
    closed_at
    lecturer_ipv4
    lecturer_ipv6
  }
  class attendance {
    <<table>>
    session_id
    roster_entry_id
    state : Present, Pending, Manual-present, Manual-absent
    ip
    block
    device_token_hash
    at
  }
  class approved_network {
    <<table>>
    session_id
    block
    approved_at
  }
  session "1" --> "*" check_in_window : one row per opening
  session "1" --> "*" approved_network : this Session only
  session "1" --> "*" attendance
  roster_entry "1" --> "*" attendance : at most one per Session
```

`attendance` is overwritten so the latest action wins. Absent is not stored: no row, or a row still Pending once the Check-in window has closed (closed by the Lecturer or at midnight, worked out from the Clock), reads as Absent.

### Feedback

```mermaid
classDiagram
  direction LR
  class course {
    <<Course>>
  }
  class session {
    <<Course>>
  }
  class roster_entry {
    <<Course>>
  }
  class topic {
    <<table>>
    id
    course_id
    kind : general, session, named
    session_id
    name
    archived_at
  }
  class comment {
    <<table>>
    id
    topic_id
    roster_entry_id
    text
    anonymous
    timing : before, during, after
    status : New, Pinned, Addressed, Ignored
    created_at
  }
  class poll {
    <<table>>
    id
    topic_id
    question
    scheduled_open_at
    scheduled_close_at
    opened_at
    closed_at
  }
  class poll_option {
    <<table>>
    id
    poll_id
    label
    position
  }
  class vote {
    <<table>>
    poll_id
    roster_entry_id
    option_id
    at
  }
  course "1" --> "*" topic
  session "1" --> "0..1" topic : its Session Topic
  topic "1" --> "*" comment
  topic "1" --> "*" poll
  poll "1" --> "2..6" poll_option
  poll "1" --> "*" vote
  roster_entry "1" --> "*" comment : author, hidden if anonymous
  roster_entry "1" --> "*" vote : one per Poll
```

Whether a Poll is open is worked out from its scheduled and manual times and the Clock, latest action winning; it is never a stored flag.

### Summaries

```mermaid
classDiagram
  direction LR
  class session {
    <<Course>>
  }
  class file {
    <<Infrastructure>>
  }
  class transcript {
    <<table>>
    id
    session_id
    file_hash
    text
  }
  class summary {
    <<table>>
    id
    session_id
    published_version_id
  }
  class summary_version {
    <<table>>
    id
    summary_id
    markdown
    author : AI or Lecturer
    created_at
  }
  class summary_translation {
    <<table>>
    summary_id
    language
    markdown
    edited_at
  }
  session "1" --> "0..1" transcript
  session "1" --> "0..1" summary
  transcript ..> file : uploaded VTT or txt
  summary "1" --> "*" summary_version : history
  summary --> summary_version : published version
  summary "1" --> "*" summary_translation : one per Course language
```

### Homework

```mermaid
classDiagram
  direction LR
  class course {
    <<Course>>
  }
  class roster_entry {
    <<Course>>
  }
  class file {
    <<Infrastructure>>
  }
  class assignment {
    <<table>>
    id
    course_id
    title
    instructions
    due_at
    released_at
    match_deadline
    matched_at
  }
  class criterion {
    <<table>>
    id
    assignment_id
    label
    position
  }
  class submission {
    <<table>>
    id
    assignment_id
    roster_entry_id
    text
    file_hash
    submitted_at
  }
  class review {
    <<table>>
    id
    submission_id
    edited_at
    released_at
  }
  class review_level {
    <<table>>
    review_id
    criterion_id
    level : Not yet, Partly, Secure
    evidence
    feedback
  }
  class class_summary {
    <<table>>
    assignment_id
    counts_per_criterion
    common_mistakes
  }
  class similarity_pair {
    <<table>>
    submission_a_id
    submission_b_id
    score
    fingerprint_overlap
    embedding_similarity
    passages
  }
  class help_request {
    <<table>>
    id
    criterion_id
    roster_entry_id
    created_at
  }
  class help_offer {
    <<table>>
    id
    criterion_id
    roster_entry_id
    created_at
  }
  class help_match {
    <<table>>
    help_request_id
    help_offer_id
  }
  course "1" --> "*" assignment
  assignment "1" --> "3..5" criterion
  assignment "1" --> "*" submission
  roster_entry "1" --> "*" submission : at most one per Assignment
  submission ..> file : PDF, text extracted in-app
  submission "1" --> "0..1" review
  review "1" --> "*" review_level : one per Criterion
  assignment "1" --> "0..1" class_summary
  assignment "1" --> "*" similarity_pair : Lecturer only
  criterion "1" --> "*" help_request
  criterion "1" --> "*" help_offer
  help_request "1" --> "0..1" help_match
  help_offer "1" --> "0..2" help_match
```

A Submission being Late is worked out from `submitted_at` and `due_at`, not stored.

### Infrastructure

```mermaid
classDiagram
  direction LR
  class job {
    <<table>>
    id
    kind
    payload
    run_at
    status
    attempts
    progress
    error
  }
  class llm_usage {
    <<table>>
    day
    requests
  }
  class file {
    <<table>>
    content_hash
    name
    mime_type
    size
  }
```

Job kinds: `summary.generate`, `summary.translate`, `review.submission`, `review.compare`, `review.classSummary`, `help.match`.
