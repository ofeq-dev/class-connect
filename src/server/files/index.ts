import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** File store (docs/diagrams/class-diagram.md): uploads kept on disk under their content hash. */
export interface FileStore {
  /** Stores the bytes and returns their content hash (sha256, hex). Storing the same bytes twice keeps one copy. */
  put(bytes: Uint8Array): Promise<string>;
  /** The stored bytes, or null when nothing is stored under that hash. */
  get(contentHash: string): Promise<Uint8Array | null>;
  /** Removes the file stored under that hash, if any. The caller checks nothing else uses it. */
  delete(contentHash: string): Promise<void>;
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * After the rows naming these files are deleted: deletes each file that `stillUsed` (the hashes
 * among these that other rows still name) doesn't return. Nulls and repeats are skipped.
 */
export async function deleteUnusedFiles(
  store: FileStore,
  hashes: (string | null)[],
  stillUsed: (hashes: string[]) => (string | null)[],
): Promise<void> {
  const unique = [...new Set(hashes.filter((h): h is string => h !== null))];
  if (!unique.length) return;
  const used = new Set(stillUsed(unique));
  for (const hash of unique) if (!used.has(hash)) await store.delete(hash);
}

export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Files live at <dir>/<first 2 hex>/<hash>. */
export function createDiskFileStore(dir: string): FileStore {
  const fileFor = (hash: string) => path.join(dir, hash.slice(0, 2), hash);
  return {
    async put(bytes) {
      const hash = contentHash(bytes);
      const target = fileFor(hash);
      try {
        await fs.access(target);
        return hash;
      } catch {
        // not stored yet
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Write then rename, so a crash never leaves a half-written file under the hash.
      const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
      await fs.writeFile(temp, bytes);
      await fs.rename(temp, target);
      return hash;
    },
    async get(hash) {
      if (!HASH.test(hash)) return null;
      try {
        return new Uint8Array(await fs.readFile(fileFor(hash)));
      } catch {
        return null;
      }
    },
    async delete(hash) {
      if (!HASH.test(hash)) return;
      await fs.rm(fileFor(hash), { force: true });
    },
  };
}
