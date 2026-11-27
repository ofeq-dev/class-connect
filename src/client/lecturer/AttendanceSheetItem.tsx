/**
 * The ⋯ menu's Attendance sheet download (UC-6). A plain link: the browser sends the Lecturer's
 * cookie and saves the xlsx under the name the server gives it.
 */
export function AttendanceSheetItem({ courseId }: { courseId: string | number }) {
  return (
    <a href={`/api/lecturer/courses/${encodeURIComponent(courseId)}/attendance.xlsx`} download>
      Download attendance sheet
    </a>
  );
}
