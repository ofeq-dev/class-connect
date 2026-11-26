/**
 * File store seam (docs/diagrams/class-diagram.md). Only the interface exists so far; the disk
 * adapter arrives with Transcript upload (#32).
 */
export interface FileStore {
  put(bytes: Uint8Array): Promise<string>;
  get(contentHash: string): Promise<Uint8Array | null>;
}
