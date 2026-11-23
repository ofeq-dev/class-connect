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
One meeting of a Course on a given date.
_Avoid_: Class, lecture, meeting, lesson

### Attendance

**Check-in**:
A Student's act of recording that they are present at a Session, by scanning the Session's QR code while on the classroom network.
_Avoid_: Sign-in, registration, attendance mark

**Classroom network**:
The Wi-Fi network the Lecturer's device is on when the Session opens; a Check-in counts only from the same network.
_Avoid_: Campus Wi-Fi, local network

**Manual mark**:
The Lecturer setting a Student's attendance for a Session directly, present or absent, at any time; it replaces whatever was recorded before.
_Avoid_: Override, manual check-in

**Check-in window**:
The period during which a Session accepts Check-ins, opened and closed by the Lecturer (and closed automatically at midnight); it may be reopened. Manual marks work whether it is open or not.
_Avoid_: Attendance period, registration window

**Attendance sheet**:
The per-Course record of who attended each Session: every Student on the Roster against every Session, each entry Present, Manual or Absent. Attendance belongs to the Roster entry, never to a phone.
_Avoid_: Register, attendance list, spreadsheet

### Identity

**Claim**:
A Student taking ownership of their Roster entry, which binds them to the phone they claimed from.
_Avoid_: Registration, sign-up, login

**Claim reset**:
The Lecturer releasing a Claim so the Student can claim again.
_Avoid_: Unbind, unlink, account reset
