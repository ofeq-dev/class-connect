import { describe, expect, it } from "vitest";
import { qrModules } from "./qr";

describe("QR code", () => {
  const url = "https://cc.ofeq.dev/s/Ab3dE5gH7jK";

  it("encodes a Session link as a square grid with the three finder patterns", () => {
    const { size, dark } = qrModules(url);
    // A 33-character URL needs version 3 (29 × 29) at error-correction level M.
    expect(size).toBe(29);
    for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
      // A finder is a dark 7 × 7 ring around a light ring around a dark 3 × 3 centre.
      expect(dark(r, c)).toBe(true);
      expect(dark(r + 6, c + 6)).toBe(true);
      expect(dark(r + 1, c + 1)).toBe(false);
      expect(dark(r + 3, c + 3)).toBe(true);
    }
  });

  it("draws the dark modules as one SVG path, a unit square each", () => {
    const { size, path } = qrModules(url);
    const squares = path.match(/M\d+ \d+h1v1h-1z/g) ?? [];
    expect(squares.length).toBeGreaterThan(size * 4);
    expect(squares.join("")).toBe(path);
    expect(path.startsWith("M0 0h1v1h-1z")).toBe(true);
  });
});
