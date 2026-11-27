import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, ok } from "../api";
import { AttendanceColumn } from "./AttendanceColumn";
import { Menu } from "./Menu";
import { ProjectorControl } from "./ProjectorControl";
import { formatDate, useCourse, useCourseLive } from "./queries";

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The live console: header, then Attendance | Comments | Poll (Comments and Poll arrive with #30 and #31). */
export function LiveConsole() {
  const { courseId = "", sessionId = "" } = useParams();
  useCourseLive(courseId);
  const course = useCourse(courseId);
  const session = useQuery({
    queryKey: ["session", Number(sessionId)],
    queryFn: async () =>
      ok(await api.api.lecturer.courses[":courseId"].sessions[":sessionId"].$get({ param: { courseId, sessionId } })),
  });
  const clock = useClock();

  if (session.error) return <p className="page error">{session.error.message}</p>;
  const s = session.data;

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <header className="top">
        <div className="top-stack">
          <Link className="crumb" to={`/lecturer/courses/${courseId}`}>← {course.data?.name ?? "Course"}</Link>
          <span className="title">{s ? `${formatDate(s.date)} · ${s.start}–${s.end}` : " "}</span>
        </div>
        <span className="clock">{clock}</span>
        <ProjectorControl courseId={courseId} sessionId={sessionId} />
        <Menu label="Console menu">
          <Link to={`/lecturer/courses/${courseId}/roster`}>Roster</Link>
        </Menu>
      </header>
      <div className="console">
        <AttendanceColumn courseId={courseId} sessionId={sessionId} />
        <section className="sec" data-s="cm">
          <div className="sec-head"><h2><span className="hl">Comments</span></h2></div>
          <p className="empty">Comments arrive later.</p>
        </section>
        <section className="sec" data-s="poll">
          <div className="sec-head"><h2><span className="hl">Poll</span></h2></div>
          <p className="empty">Polls arrive later.</p>
        </section>
      </div>
    </div>
  );
}
