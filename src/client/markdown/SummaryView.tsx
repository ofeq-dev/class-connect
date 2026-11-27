import { useMemo } from "react";
import { renderSummary } from "./render";

/** A Session summary's Markdown, sanitised and laid out per block (see renderSummary). */
export function SummaryView({ markdown, className }: { markdown: string; className?: string }) {
  const html = useMemo(() => renderSummary(markdown), [markdown]);
  return <div className={["summary-md", className].filter(Boolean).join(" ")} dangerouslySetInnerHTML={{ __html: html }} />;
}
