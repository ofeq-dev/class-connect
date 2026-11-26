import { Route, Routes } from "react-router";
import { ClaimPage } from "./ClaimPage";
import { StudentShell } from "./StudentShell";
import "./student.css";

/** The Student phone app: the QR entry at /s/<code>, and the app itself at /. */
export function StudentApp() {
  return (
    <div className="st">
      <Routes>
        <Route path="s/:code" element={<ClaimPage />} />
        <Route path="*" element={<StudentShell />} />
      </Routes>
    </div>
  );
}
