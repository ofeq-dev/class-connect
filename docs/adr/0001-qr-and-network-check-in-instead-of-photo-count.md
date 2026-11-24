# Check-in by Session QR code and classroom network, not by photo head count

The brief suggests the Lecturer photograph the room for an automatic head count. Instead, a Student checks in by scanning one fixed QR code per Session, and the check-in is accepted only if the Student's public IP falls in the same block as the Lecturer's (same IPv4 `/24`, or same IPv6 `/64`). Off-network check-ins are refused with "Connect to the classroom Wi-Fi and try again", and the Lecturer can mark a Student present by hand as the fallback. We chose this because it gives per-Student attendance (a head count only gives a number to reconcile), avoids processing photos of people, and needs no ML model to ship in a week.

## Considered Options

- **Photo head count** (the brief's example): rejected. It yields a count, not identities; accuracy on crowded classroom photos is uncertain; it means handling photos of Students.
- **Rotating QR code**: rejected. Once a Student must be on the classroom network, a forwarded link already fails off-site, so a rotating code adds friction for little gain.
- **Exact IP match**: rejected. Campus networks may send traffic out through a pool of public addresses, and phones on IPv6 each get their own address.

## Consequences

- A friend elsewhere on the same campus network could check in from a forwarded link. Accepted as a known gap.
- The matching rule depends on the real classroom network, which must be measured before the demo.

## Amendment: Pending instead of refused (2026-11-25)

Resolved in [System architecture and components](https://github.com/ofeq-dev/class-connect/issues/10). An off-network Check-in is no longer refused. It is recorded as a **Pending check-in** ("Checked in — waiting for your Lecturer to confirm"). The Lecturer console groups Pending check-ins by network block, and a **Network approval** makes that block a Classroom network, turning its Pending check-ins into Present. Approval is either one tap from the Lecturer, or automatic once a per-Course number of Students (default 10) have checked in from the block. Approved networks are remembered per Course, and the Lecturer can remove them. Pending check-ins still unapproved when the Check-in window closes count as Absent, and the Lecturer can still Manual mark them.

The Lecturer's own addresses are still captured when the window opens: both IPv4 and IPv6, reported by the Lecturer's browser via `api4.ipify.org` / `api6.ipify.org` (see ADR 0003). We changed this because the Lecturer may not be on the Students' network (a laptop on Ethernet, Students on Wi-Fi), and a crowd of Students from one block is good evidence that they are in the room together.

New consequence: a group of Students elsewhere on one network could get their block approved automatically. That is unlikely at the threshold, and the Lecturer can remove the network and Manual mark.
