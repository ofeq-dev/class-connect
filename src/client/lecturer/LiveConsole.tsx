import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, ok } from "../api";
import { AttendanceColumn } from "./AttendanceColumn";
import { AttendanceSheetItem } from "./AttendanceSheetItem";
import { CommentsColumn } from "./CommentsColumn";
import { DiagnosticsItem } from "./DiagnosticsItem";
import { Menu } from "./Menu";
import { PollColumn } from "./PollColumn";
import { ProjectorControl } from "./ProjectorControl";
import { currentPoll, formatDate, useCourse, useCourseLive, useSessionPolls } from "./queries";

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The live console: header, then Attendance | Comments | Poll. */
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
  // The Poll the column shows; the projector's Poll mode shows the same one.
  const [pollFocus, setPollFocus] = useState<number | null>(null);
  const polls = useSessionPolls(courseId, sessionId);
  const poll = currentPoll(polls.data, pollFocus);

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
        <ProjectorControl
          courseId={courseId}
          sessionId={sessionId}
          pollId={poll && (poll.status === "open" || poll.status === "closed") ? poll.id : null}
        />
        <Menu label="Console menu">
          <Link to={`/lecturer/courses/${courseId}/roster`}>Roster</Link>
          <Link to={`/lecturer/courses/${courseId}/topics`}>Topics</Link>
          <AttendanceSheetItem courseId={courseId} />
          <DiagnosticsItem />
        </Menu>
      </header>
      <div className="console">
        <AttendanceColumn courseId={courseId} sessionId={sessionId} />
        <CommentsColumn courseId={courseId} sessionId={sessionId} />
        <PollColumn courseId={courseId} sessionId={sessionId} focus={pollFocus} setFocus={setPollFocus} />
      </div>
    </div>
  );
}
