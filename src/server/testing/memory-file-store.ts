import { contentHash, type FileStore } from "../files";

/** Keeps bytes in a map under their content hash. */
export class MemoryFileStore implements FileStore {
  private readonly files = new Map<string, Uint8Array>();
  put(bytes: Uint8Array): Promise<string> {
    const hash = contentHash(bytes);
    this.files.set(hash, new Uint8Array(bytes));
    return Promise.resolve(hash);
  }
  get(hash: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(hash) ?? null);
  }
}
