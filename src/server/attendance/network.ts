import { isIPv4, isIPv6 } from "node:net";

/** An address reduced to its network block (ADR 0001): IPv4 /24 or IPv6 /64. */
export type Block = { family: 4 | 6; block: string };

/** The 8 hextets of an IPv6 address, or null if it isn't one. */
function hextets(ip: string): number[] | null {
  if (!isIPv6(ip)) return null;
  let text = ip.split("%")[0]!;
  // A trailing dotted IPv4 (::ffff:1.2.3.4) becomes two hextets.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split(".").map(Number) as [number, number, number, number];
    text = text.slice(0, -dotted[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const zeros = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(zeros).fill("0"), ...right].map((h) => parseInt(h, 16));
}

/**
 * The block an address belongs to. IPv4-mapped IPv6 (::ffff:a.b.c.d) counts as IPv4, so it is
 * compared with the Lecturer's IPv4. Null for anything that isn't an IP address.
 */
export function blockOf(raw: string | null | undefined): Block | null {
  const ip = raw?.trim() ?? "";
  if (isIPv4(ip)) return { family: 4, block: `${ip.split(".").slice(0, 3).join(".")}.0/24` };
  const h = hextets(ip);
  if (!h) return null;
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    const v4 = [h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8].join(".");
    return { family: 4, block: `${v4}.0/24` };
  }
  return { family: 6, block: `${h.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64` };
}
