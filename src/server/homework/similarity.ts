/**
 * Similarity between Submissions (#11): winnowing fingerprints written in-app, plus the cosine
 * of the texts' embeddings. A pair is information for the Lecturer only; it changes no level.
 */

/** Words per shingle. */
const K = 5;
/** Shingles per winnowing window. */
const W = 4;
/** Tuned so the seeded near-copy pair flags and unrelated Submissions don't. */
export const SIMILARITY_THRESHOLD = 0.6;
const MAX_PASSAGES = 5;

interface Token {
  word: string;
  start: number;
  end: number;
}

export interface Fingerprinted {
  text: string;
  tokens: Token[];
  /** Selected shingle hash → the token positions where that shingle starts. */
  prints: Map<number, number[]>;
}

export interface Passage {
  a: string;
  b: string;
}

export interface Comparison {
  fingerprintOverlap: number;
  passages: Passage[];
}

function tokenize(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
    word: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** 32-bit FNV-1a. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Winnowing: the minimum hash of every window of W shingles (the rightmost on a tie). */
export function fingerprint(text: string): Fingerprinted {
  const tokens = tokenize(text);
  const hashes: number[] = [];
  for (let i = 0; i + K <= tokens.length; i++) {
    hashes.push(hash(tokens.slice(i, i + K).map((t) => t.word).join(" ")));
  }
  const selected = new Set<number>();
  if (hashes.length > 0 && hashes.length < W) {
    selected.add(hashes.indexOf(Math.min(...hashes)));
  }
  for (let i = 0; i + W <= hashes.length; i++) {
    let min = i;
    for (let j = i + 1; j < i + W; j++) if (hashes[j]! <= hashes[min]!) min = j;
    selected.add(min);
  }
  const prints = new Map<number, number[]>();
  for (const position of [...selected].sort((a, b) => a - b)) {
    const h = hashes[position]!;
    prints.set(h, [...(prints.get(h) ?? []), position]);
  }
  return { text, tokens, prints };
}

/** Shared fingerprints over the smaller set, and the matching passages merged into runs. */
export function compareFingerprints(a: Fingerprinted, b: Fingerprinted): Comparison {
  const smaller = Math.min(a.prints.size, b.prints.size);
  if (smaller === 0) return { fingerprintOverlap: 0, passages: [] };
  const matches: { a: number; b: number }[] = [];
  for (const [h, positions] of a.prints) {
    const inB = b.prints.get(h);
    if (inB) matches.push({ a: positions[0]!, b: inB[0]! });
  }
  const shared = matches.length;
  matches.sort((x, y) => x.a - y.a);

  // Token ranges [start, end) in each text, merged while both sides run on together.
  const runs: { aStart: number; aEnd: number; bStart: number; bEnd: number }[] = [];
  for (const m of matches) {
    const last = runs.at(-1);
    if (last && m.a <= last.aEnd + K && m.b >= last.bStart && m.b <= last.bEnd + K) {
      last.aEnd = Math.max(last.aEnd, m.a + K);
      last.bEnd = Math.max(last.bEnd, m.b + K);
    } else {
      runs.push({ aStart: m.a, aEnd: m.a + K, bStart: m.b, bEnd: m.b + K });
    }
  }
  const span = (f: Fingerprinted, start: number, end: number) =>
    f.text.slice(f.tokens[start]!.start, f.tokens[Math.min(end, f.tokens.length) - 1]!.end);
  const passages = runs
    .sort((x, y) => y.aEnd - y.aStart - (x.aEnd - x.aStart))
    .slice(0, MAX_PASSAGES)
    .sort((x, y) => x.aStart - y.aStart)
    .map((r) => ({ a: span(a, r.aStart, r.aEnd), b: span(b, r.bStart, r.bEnd) }));
  return { fingerprintOverlap: Math.min(1, shared / smaller), passages };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Both signals averaged; the fingerprints alone when the embedding call failed. */
export function similarityScore(fingerprintOverlap: number, embeddingSimilarity: number | null): number {
  return embeddingSimilarity === null ? fingerprintOverlap : (fingerprintOverlap + embeddingSimilarity) / 2;
}
