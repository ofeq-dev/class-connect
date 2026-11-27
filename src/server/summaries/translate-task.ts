import type { LlmTask } from "../llm";

export interface TranslateInput {
  /** The published version's Markdown. */
  markdown: string;
  /** A Course language code, e.g. "ar". */
  language: string;
}

const TIMESTAMP = /\d{1,2}:\d{2}(?::\d{2})?/g;
const timestamps = (markdown: string) => markdown.match(TIMESTAMP) ?? [];

/**
 * The `translate` task: one request turns the published Session summary into a Course language.
 * The schema holds the reply to the source's outline timestamps, unchanged and in order, so a
 * reply that drops or rewrites one gets the gateway's fix-up retry.
 */
export function translate(source: string): LlmTask<TranslateInput, { markdown: string }> {
  const expected = timestamps(source);
  return {
    name: "translate",
    timeoutMs: 3 * 60_000,
    prompt: ({ markdown, language }) =>
      [
        `Translate this university Session summary into the language with code "${language}".`,
        "Keep the Markdown structure exactly: headings, lists, numbering and code spans.",
        "Copy every timestamp (such as `00:01:10`) unchanged.",
        'Reply with only a JSON object of this shape: {"markdown": string}',
        "",
        "Summary:",
        markdown,
      ].join("\n"),
    parse(reply) {
      const md = (reply as { markdown?: unknown } | null)?.markdown;
      if (typeof md !== "string" || !md.trim()) throw new Error("markdown must be a non-empty string");
      if (timestamps(md).join(" ") !== expected.join(" ")) {
        throw new Error(`the timestamps must stay unchanged: ${expected.join(", ") || "(none)"}`);
      }
      return { markdown: md };
    },
  };
}
