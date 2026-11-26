import DOMPurify from "dompurify";
import { marked } from "marked";

/** Blocks that take their direction from their own text. */
const BLOCKS = "p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, dt, dd";
/** [01:02:03], 01:02:03, 10:15: an outline or Transcript time. */
const TIMESTAMP = /\[\d{1,2}:\d{2}(?::\d{2})?\]|\b\d{1,2}:\d{2}(?::\d{2})?\b/g;
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const LETTER = /\p{L}/u;

/** The direction of the first strong letter, ignoring code and timestamps; null when there is none. */
function directionOf(el: Element): "rtl" | "ltr" | null {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest("code, .ts")) continue;
    const letter = node.textContent?.match(LETTER)?.[0];
    if (letter) return RTL_LETTER.test(letter) ? "rtl" : "ltr";
  }
  return null;
}

/** Wraps bare timestamps in text so they stay left-to-right inside right-to-left lines. */
function isolateTimestamps(root: Element) {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest("code, pre")) texts.push(node as Text);
  }
  for (const text of texts) {
    const value = text.data;
    if (value.search(TIMESTAMP) === -1) continue;
    const parts = doc.createDocumentFragment();
    let at = 0;
    for (const match of value.matchAll(TIMESTAMP)) {
      parts.append(value.slice(at, match.index));
      const span = doc.createElement("span");
      span.className = "ts";
      span.dir = "ltr";
      span.textContent = match[0];
      parts.append(span);
      at = match.index + match[0].length;
    }
    parts.append(value.slice(at));
    text.replaceWith(parts);
  }
}

/**
 * Session summary Markdown → safe HTML: sanitised with DOMPurify, each block's direction taken
 * from its own text, and code and timestamps kept left-to-right (an element with `dir` is
 * isolated from the text around it).
 */
export function renderSummary(markdown: string): string {
  const clean = DOMPurify.sanitize(marked.parse(markdown, { async: false }));
  const root = document.createElement("div");
  root.innerHTML = clean;
  isolateTimestamps(root);
  for (const code of root.querySelectorAll("code")) code.dir = "ltr";
  for (const block of root.querySelectorAll<HTMLElement>(BLOCKS)) block.dir = directionOf(block) ?? "auto";
  return root.innerHTML;
}
