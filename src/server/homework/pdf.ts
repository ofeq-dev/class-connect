import { extractText, getDocumentProxy } from "unpdf";

/** The text of every page, or null when the bytes aren't a PDF it can read. */
export async function pdfText(bytes: Uint8Array): Promise<string | null> {
  try {
    // pdf.js may take ownership of the buffer it's given, so it gets a copy.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } catch {
    return null;
  }
}
