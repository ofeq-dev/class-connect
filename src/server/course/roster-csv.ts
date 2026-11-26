/** One parsed line of a Roster CSV, before it meets the existing Roster. */
export type CsvRow =
  | { line: number; ok: true; studentId: string; name: string }
  | { line: number; ok: false; reason: string; raw: string };

/** Splits CSV text into records, honouring quoted fields ("a, b" and doubled quotes). */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field.trim() === "") {
      // A quote opens a quoted field only at its start; elsewhere (ת"ז) it is a character.
      quoted = true;
      field = "";
    }
    else if (ch === "," || ch === ";" || ch === "\t") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

const ID_HEADER = /\b(id|number|no)\b|ת"?ז|מספר/i;
const NAME_HEADER = /\bname\b|שם/i;

/**
 * Reads Roster rows of a name and a student ID, in either order. A header row is recognised
 * by its labels and used to find the columns; without one, the column that looks like an ID
 * (digits) is the student ID.
 */
export function readRosterCsv(text: string): CsvRow[] {
  const records = parseCsv(text)
    .map((cells, index) => ({ line: index + 1, cells: cells.map((c) => c.trim()) }))
    .filter((r) => r.cells.some((c) => c !== ""));
  if (records.length === 0) return [];

  let idCol = 1;
  let nameCol = 0;
  const first = records[0]!.cells;
  const headerId = first.findIndex((c) => ID_HEADER.test(c));
  const headerName = first.findIndex((c, i) => NAME_HEADER.test(c) && i !== headerId);
  let rows = records;
  if (headerId !== -1 && headerName !== -1) {
    idCol = headerId;
    nameCol = headerName;
    rows = records.slice(1);
  } else if (/^\d+$/.test(first[0] ?? "") && !/^\d+$/.test(first[1] ?? "")) {
    idCol = 0;
    nameCol = 1;
  }

  return rows.map(({ line, cells }) => {
    const raw = cells.join(", ");
    const studentId = cells[idCol] ?? "";
    const name = (cells[nameCol] ?? "").replace(/\s+/g, " ");
    if (!studentId) return { line, ok: false, reason: "No student ID.", raw };
    if (!name) return { line, ok: false, reason: "No name.", raw };
    if (studentId.length > 32) return { line, ok: false, reason: "Student ID is too long.", raw };
    return { line, ok: true, studentId, name };
  });
}
