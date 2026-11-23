# Check-in by Session QR code and classroom network, not by photo head count

The brief suggests the Lecturer photograph the room for an automatic head count. Instead, a Student checks in by scanning one fixed QR code per Session, and the check-in is accepted only if the Student's public IP falls in the same block as the Lecturer's (same IPv4 `/24`, or same IPv6 `/64`). Off-network check-ins are refused with "Connect to the classroom Wi-Fi and try again", and the Lecturer can mark a Student present by hand as the fallback. We chose this because it gives per-Student attendance (a head count only gives a number to reconcile), avoids processing photos of people, and needs no ML model to ship in a week.

## Considered Options

- **Photo head count** (the brief's example): rejected. It yields a count, not identities; accuracy on crowded classroom photos is uncertain; it means handling photos of Students.
- **Rotating QR code**: rejected. Once a Student must be on the classroom network, a forwarded link already fails off-site, so a rotating code adds friction for little gain.
- **Exact IP match**: rejected. Campus networks may send traffic out through a pool of public addresses, and phones on IPv6 each get their own address.

## Consequences

- A friend elsewhere on the same campus network could check in from a forwarded link. Accepted as a known gap.
- The matching rule depends on the real classroom network, which must be measured before the demo.
