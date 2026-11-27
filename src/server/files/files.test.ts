import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDiskFileStore } from ".";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-files-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const bytes = (s: string) => new TextEncoder().encode(s);
const filesUnder = (d: string): string[] =>
  fs.readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);

describe("File store on disk", () => {
  it("stores a file under its content hash and reads back the same bytes", async () => {
    const store = createDiskFileStore(dir);
    const content = bytes("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n");
    const hash = await store.put(content);
    expect(hash).toBe(createHash("sha256").update(content).digest("hex"));
    expect(await store.get(hash)).toEqual(content);
  });

  it("keeps the same bytes stored twice once", async () => {
    const store = createDiskFileStore(dir);
    const a = await store.put(bytes("same"));
    const b = await store.put(bytes("same"));
    expect(b).toBe(a);
    expect(filesUnder(dir)).toHaveLength(1);
  });

  it("survives a new store over the same folder", async () => {
    const hash = await createDiskFileStore(dir).put(bytes("kept"));
    expect(await createDiskFileStore(dir).get(hash)).toEqual(bytes("kept"));
  });

  it("returns null for a missing hash, and for anything that isn't a hash", async () => {
    const store = createDiskFileStore(dir);
    expect(await store.get("0".repeat(64))).toBeNull();
    expect(await store.get("../../etc/passwd")).toBeNull();
  });

  it("deletes a stored file, and deleting what isn't stored does nothing", async () => {
    const store = createDiskFileStore(dir);
    const hash = await store.put(bytes("gone"));
    const kept = await store.put(bytes("kept"));
    await store.delete(hash);
    await store.delete(hash);
    await store.delete("../../etc/passwd");
    expect(await store.get(hash)).toBeNull();
    expect(await store.get(kept)).toEqual(bytes("kept"));
  });
});
