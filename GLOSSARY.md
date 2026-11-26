# Class Connect

A set of simple, phone-first teaching tools for a live course: attendance, real-time feedback, polls, lecture summaries and homework review.

## Language

### People

**Lecturer**:
The person who runs a Course and its Sessions.
_Avoid_: Teacher, instructor, admin

**Student**:
A person enrolled in a Course who attends its Sessions.
_Avoid_: Pupil, user, participant

### Teaching structure

**Course**:
An ongoing class with its enrolled Students, run by a Lecturer across many Sessions.
_Avoid_: Class, module

**Roster**:
The list of Students enrolled in a Course, imported by the Lecturer.
_Avoid_: Class list, enrolment list, register

**Session**:
One meeting of a Course, scheduled for a date with a start and end time.
_Avoid_: Class, lecture, meeting, lesson

### Attendance

**Check-in**:
A Student's act of recording that they are present at a Session, by scanning the Session's QR code. From the Classroom network it counts at once; from any other network it is Pending.
_Avoid_: Sign-in, registration, attendance mark

**Classroom network**:
A network a Session accepts Check-ins from: the one the Lecturer's device is on when the Check-in window opens, plus any network approved for the Session.
_Avoid_: Campus Wi-Fi, local network

**Pending check-in**:
A Check-in from a network that is not yet a Classroom network, waiting for that network to be approved; if the Check-in window closes first, the Student counts as Absent.
_Avoid_: Unverified check-in, refused check-in

**Network approval**:
The Lecturer making a network a Classroom network for one Session, with one tap; every Pending check-in from that network then counts. It is never remembered for later Sessions.
_Avoid_: Whitelisting, IP approval

**Manual mark**:
The Lecturer setting a Student's attendance for a Session directly, present or absent, at any time; it replaces whatever was recorded before.
_Avoid_: Override, manual check-in

**Check-in window**:
The period during which a Session accepts Check-ins, opened and closed by the Lecturer (and closed automatically at midnight); it may be reopened. Manual marks work whether it is open or not.
_Avoid_: Attendance period, registration window

**Attendance sheet**:
The per-Course record of who attended each Session: every Student on the Roster against every Session, each entry Present, Manual or Absent. Attendance belongs to the Roster entry, never to a phone.
_Avoid_: Register, attendance list, spreadsheet

### Feedback

**Topic**:
What a Comment or Poll is about: the Course in general, one Session, or a named item the Lecturer adds such as an assignment or exam.
_Avoid_: Subject, category, channel

**Comment**:
A message a Student sends the Lecturer about one Topic, named unless the Student chooses to send it anonymously; only the Lecturer and its author see it.
_Avoid_: Feedback, question, post, message

**Poll**:
A single-choice question the Lecturer puts to the Students about one Topic, open for a period the Lecturer sets.
_Avoid_: Survey, quiz, vote

**Vote**:
A Student's one answer to a Poll, changeable while the Poll is open; the Lecturer sees only totals.
_Avoid_: Response, answer, ballot

### Identity

**Claim**:
A Student taking ownership of their Roster entry, which binds them to the phone they claimed from.
_Avoid_: Registration, sign-up, login

**Claim reset**:
The Lecturer releasing a Claim so the Student can claim again.
_Avoid_: Unbind, unlink, account reset

### Session summaries

**Transcript**:
The text record of what was said in a Session, with timestamps, uploaded by the Lecturer.
_Avoid_: Captions, subtitles, recording

**Session summary**:
The AI-generated overview of a Session built from its Transcript, reviewed by the Lecturer before Students can see it.
_Avoid_: Video summary, lecture summary, notes

### Homework

**Assignment**:
A piece of homework the Lecturer sets on a Course, with instructions and a due date.
_Avoid_: Homework (as a count noun), task, exercise

**Submission**:
A Student's single hand-in for an Assignment, as pasted text or a PDF; it can be replaced until the due date, and one handed in after it is Late.
_Avoid_: Answer, upload, attempt

**Criterion**:
One of the 3–5 things an Assignment's Submissions are judged on, such as a single question or a skill; each Submission reaches one of three levels on it: Not yet, Partly or Secure.
_Avoid_: Rubric item, question (as the unit of judgement), mark

**Review**:
The judgement of one Submission: a level, evidence and feedback for every Criterion. Drafted automatically, it can be edited by the Lecturer and is seen by the Student only once released.
_Avoid_: Grade, marking, feedback (as the whole)

**Release**:
The Lecturer publishing an Assignment's results all at once: every Student's Review and the class summary, which also opens Help requests and offers. It waits until every Submission handed in on time has a Review. The Review of a Late Submission is released on its own afterwards.
_Avoid_: Publish, return, send out

**Help request**:
A Student asking, after Release, for a classmate's help with one Criterion of an Assignment where they reached Not yet or Partly; they do not know who might help.
_Avoid_: Help ticket, plea

**Helper**:
A Student who reached Secure on a Criterion and offered, after Release, to help a classmate with it; they do not know who might ask.
_Avoid_: Tutor, mentor, buddy

**Help match**:
The pairing of a Help request with a Helper's offer on the same Criterion, made by the app in one pass when the match deadline passes or the Lecturer matches early; only then do the two learn each other's names. After that pass no more Help requests or offers are taken.
_Avoid_: Buddy pairing, peer assignment
