import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./index";

describe("Lecturer password", () => {
  it("verifies the right password and refuses a wrong or malformed one", () => {
    const stored = hashPassword("s3cret");
    expect(verifyPassword("s3cret", stored)).toBe(true);
    expect(verifyPassword("S3cret", stored)).toBe(false);
    expect(verifyPassword("s3cret", "plain-text")).toBe(false);
  });

  it("salts each hash", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });
});
