import { useQuery } from "@tanstack/react-query";
import { Route, Routes } from "react-router";
import { api, ApiError, ok } from "../api";
import { AssignmentPage } from "./AssignmentPage";
import { CourseDesk } from "./CourseDesk";
import { CourseSettingsPage } from "./CourseSettingsPage";
import { CoursesPage } from "./CoursesPage";
import { LiveConsole } from "./LiveConsole";
import { RosterPage } from "./RosterPage";
import { SignInPage } from "./SignInPage";
import { SummaryPage } from "./SummaryPage";

export function LecturerApp() {
  const me = useQuery({
    queryKey: ["lecturer", "me"],
    queryFn: async () => ok(await api.api.lecturer.me.$get()),
  });

  if (me.isPending) return null;
  if (me.error instanceof ApiError && me.error.status === 401) return <SignInPage />;
  if (me.error) return <p className="page error">{me.error.message}</p>;
  return (
    <Routes>
      <Route index element={<CoursesPage />} />
      <Route path="courses/:courseId" element={<CourseDesk />} />
      <Route path="courses/:courseId/roster" element={<RosterPage />} />
      <Route path="courses/:courseId/settings" element={<CourseSettingsPage />} />
      <Route path="courses/:courseId/sessions/:sessionId/live" element={<LiveConsole />} />
      <Route path="courses/:courseId/sessions/:sessionId/summary" element={<SummaryPage />} />
      <Route path="courses/:courseId/assignments/new" element={<AssignmentPage />} />
      <Route path="courses/:courseId/assignments/:assignmentId" element={<AssignmentPage />} />
      <Route path="*" element={<p className="page">Nothing here. <a href="/lecturer">Your Courses</a></p>} />
    </Routes>
  );
}
