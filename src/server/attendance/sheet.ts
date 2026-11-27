import ExcelJS from "exceljs";

/** One cell of the Attendance sheet: a Check-in, a Manual mark present, or neither. */
export type SheetMark = "present" | "manual" | "absent";

export interface SheetSession {
  id: number;
  /** YYYY-MM-DD and HH:MM, in the app's time zone. */
  date: string;
  start: string;
  end: string;
}

export interface SheetStudent {
  rosterEntryId: number;
  studentId: string;
  name: string;
  /** One per Session, in the sheet's column order. */
  marks: SheetMark[];
  /** Sessions attended, Manual included. */
  attended: number;
  /** attended out of the sheet's Sessions, rounded to a whole percent; 0 with no Sessions. */
  percent: number;
}

/** The per-Course Attendance sheet (FR-ATT-14). Check-in times are kept but never shown. */
export interface AttendanceSheet {
  courseName: string;
  /** Sessions held so far (dated today or earlier), in date and start-time order. */
  sessions: SheetSession[];
  /** Every Roster entry, claimed or not, by name. */
  students: SheetStudent[];
  /** Students attending each Session, Manual included. */
  headcount: number[];
}

const MARK_TEXT: Record<SheetMark, string> = { present: "Present", manual: "Manual", absent: "Absent" };

const DAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** "Mon 23 Nov 2026", with the start time added when the day has more than one Session. */
function columnTitle(s: SheetSession, sessions: SheetSession[]) {
  const parts = Object.fromEntries(DAY.formatToParts(new Date(`${s.date}T12:00:00Z`)).map((p) => [p.type, p.value]));
  const day = `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`;
  return sessions.filter((o) => o.date === s.date).length > 1 ? `${day} ${s.start}` : day;
}

const SOFT = { argb: "FFEDEFF2" };
const MARK_FILL: Record<SheetMark, { argb: string } | null> = {
  present: { argb: "FFDCF2E3" },
  manual: { argb: "FFFFF1CC" },
  absent: null,
};

/** The sheet as an xlsx workbook: one row per Student, a column per Session, totals and a headcount row. */
export async function sheetToXlsx(sheet: AttendanceSheet): Promise<Uint8Array<ArrayBuffer>> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Class Connect";
  const ws = workbook.addWorksheet("Attendance", { views: [{ state: "frozen", xSplit: 2, ySplit: 1 }] });
  const n = sheet.sessions.length;

  ws.columns = [
    { header: "Student ID", width: 12 },
    { header: "Name", width: 28 },
    ...sheet.sessions.map((s) => ({ header: columnTitle(s, sheet.sessions), width: 17 })),
    { header: "Attended", width: 10 },
    { header: "%", width: 8, style: { numFmt: "0%" } },
  ];
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.eachCell((cell) => (cell.fill = { type: "pattern", pattern: "solid", fgColor: SOFT }));

  for (const student of sheet.students) {
    const row = ws.addRow([
      student.studentId,
      student.name,
      ...student.marks.map((m) => MARK_TEXT[m]),
      student.attended,
      n ? student.attended / n : 0,
    ]);
    student.marks.forEach((m, i) => {
      const fill = MARK_FILL[m];
      if (fill) row.getCell(3 + i).fill = { type: "pattern", pattern: "solid", fgColor: fill };
    });
  }

  const totals = ws.addRow([null, "Headcount", ...sheet.headcount]);
  totals.font = { bold: true };
  totals.border = { top: { style: "thin" } };

  for (let col = 3; col <= 4 + n; col++) ws.getColumn(col).alignment = { horizontal: "center" };
  return Uint8Array.from(Buffer.from(await workbook.xlsx.writeBuffer()));
}
