# No Student accounts: Roster claim and device binding

Students have no passwords or accounts. The Lecturer imports a Roster per Course. Each Student claims their Roster entry once by entering their student ID (after confirming "You are <name>. Correct?"), and the claim binds that Student to that phone with a long-lived device token: one device per Student and one Student per device. The first claim wins, with no email verification. The Lecturer fixes mistakes by resetting a claim with one tap, which releases the binding immediately. We chose this because Check-in has to take one scan, a sign-in screen in class kills that, and an email-code service is not worth its cost in a one-week build.

## Considered Options

- **Email one-time code at claim**: rejected. It needs an email provider and adds a step, for protection against a rare abuse that a visible Lecturer reset already handles.
- **Open join link with Lecturer approval**: rejected. The attendance spreadsheet needs every enrolled Student listed, including those who never show up, which a Roster gives from day one.

## Consequences

- An absent Student could claim their entry on a friend's phone before the semester starts, letting the friend check in for them later. Accepted as a known gap.
- A Student on a new phone, or one who cleared their browser data, needs a Lecturer reset before they can check in.
