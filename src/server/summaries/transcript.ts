import { DomainError } from "../errors";

export const NO_TIMESTAMPS_WARNING = "No timestamps found — the outline won't have times.";
const MAX_CHARS = 2_000_000;
const TIMING = /^(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,]\d{1,3}\s+-->/;
const ANY_TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;

export interface ReadTranscript {
  text: string;
  hasTimestamps: boolean;
}

/**
 * Turns an uploaded `.vtt` / `.txt` or pasted Transcript into the stored text. VTT cues become
 * "[hh:mm:ss] text" lines: cue numbers and end times go, start times stay.
 */
export function readTranscript(input: { fileName?: string | null; text: string }): ReadTranscript {
  const name = input.fileName?.trim().toLowerCase() ?? "";
  if (name && !name.endsWith(".vtt") && !name.endsWith(".txt")) {
    throw new DomainError("transcript.file-type", "Upload a .vtt or .txt Transcript, or paste the text.");
  }
  if (input.text.length > MAX_CHARS) {
    throw new DomainError("transcript.too-long", "That Transcript is too long.");
  }
  const raw = input.text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const isVtt = name.endsWith(".vtt") || (!name && raw.trimStart().startsWith("WEBVTT"));
  const text = isVtt ? readVtt(raw) : raw.trim();
  if (!text) {
    throw new DomainError(
      "transcript.empty",
      isVtt ? "That VTT file has no captions in it." : "The Transcript is empty.",
    );
  }
  return { text, hasTimestamps: isVtt || ANY_TIME.test(text) };
}

function readVtt(raw: string): string {
  const lines: string[] = [];
  for (const block of raw.split(/\n{2,}/)) {
    const rows = block.split("\n").map((r) => r.trim()).filter(Boolean);
    const timingAt = rows.findIndex((r) => r.includes("-->"));
    if (timingAt === -1) continue; // the WEBVTT header, NOTE, STYLE and REGION blocks
    const m = TIMING.exec(rows[timingAt]!);
    if (!m) continue;
    const words = rows.slice(timingAt + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (!words) continue;
    lines.push(`[${(m[1] ?? "0").padStart(2, "0")}:${m[2]}:${m[3]}] ${words}`);
  }
  return lines.join("\n");
}
