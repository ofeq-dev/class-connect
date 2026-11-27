import { useState } from "react";
import { Link, NavLink, Route, Routes, useLocation, useParams } from "react-router";
import { checkInLine } from "../attendance";
import { useLiveEvents } from "../live";
import { SummaryView } from "../markdown/SummaryView";
import { AssignmentPage } from "./AssignmentPage";
import { CommentTab, MineTab } from "./CommentTabs";
import {
  dueLabel,
  longDate,
  useStudentAssignments,
  useStudentMe,
  useStudentSummaries,
  useStudentSummary,
} from "./queries";

const TABS = [
  { path: "/", key: "today", label: "Today" },
  { path: "/polls", key: "polls", label: "Polls" },
  { path: "/comment", key: "comment", label: "Comment" },
  { path: "/mine", key: "mine", label: "Mine" },
] as const;

type Me = Extract<NonNullable<ReturnType<typeof useStudentMe>["data"]>, { claimed: true }>;

/** The Student app at /: four ring-binder tabs, each with its own highlighter. */
export function StudentShell() {
  const me = useStudentMe();
  const claimed = me.data?.claimed === true;
  useLiveEvents(claimed ? "/api/student/events" : null);
  const { pathname } = useLocation();

  if (me.isPending) return null;
  if (me.error) {
    return (
      <main className="flow">
        <p className="eyebrow">Class Connect</p>
        <h1>Something went wrong</h1>
        <p className="err">{me.error.message}</p>
      </main>
    );
  }
  if (!me.data.claimed) return <Welcome />;

  const tab = TABS.find((t) => t.path === pathname)?.key ?? "today";
  return (
    <div className="binder" data-tab={tab}>
      <main className="page-sheet">
        <Routes>
          <Route index element={<Today me={me.data} />} />
          <Route
            path="polls"
            element={
              <Empty title="Polls">
                No open polls right now. When your Lecturer opens one, it shows here and you vote with one tap.
              </Empty>
            }
          />
          <Route path="comment" element={<CommentTab myName={me.data.me.name} />} />
          <Route path="mine" element={<MineTab />} />
          <Route path="assignments/:assignmentId" element={<AssignmentPage />} />
          <Route path="summaries/:sessionId" element={<SummaryRead />} />
          <Route path="*" element={<Today me={me.data} />} />
        </Routes>
      </main>
      <nav className="tabbar" aria-label="Sections">
        {TABS.map((t) => (
          <NavLink key={t.key} to={t.path} end className="tab" data-k={t.key}>
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function Today({ me }: { me: Me }) {
  const { session } = me;
  return (
    <>
      <p className="bd-course">{me.course.name}</p>
      {session ? (
        <>
          <h1 className="bd-title">Today’s Session</h1>
          <p className="bd-when">
            {longDate(session.date)}, {session.start} to {session.end}
          </p>
          {me.checkIn && <CheckInLine checkIn={me.checkIn} />}
        </>
      ) : (
        <>
          <h1 className="bd-title">No Session today</h1>
          <p className="bd-when">{longDate(me.today)}</p>
        </>
      )}
      <Assignments />
      <div className="quick">
        <Link className="qa" to="/comment">
          <b>Message the Lecturer</b>
          <span>With your name or anonymously</span>
        </Link>
      </div>
      <Summaries />
      <p className="bd-who">
        This phone is set up for <b>{me.me.name}</b>.
      </p>
    </>
  );
}

const MARK = { ok: "✓", wait: "?", todo: "", bad: "!" } as const;

/** Today's one Check-in spot: checked in, waiting for the Lecturer, not yet, or closed. */
function CheckInLine({ checkIn }: { checkIn: NonNullable<Me["checkIn"]> }) {
  const line = checkInLine(checkIn);
  return (
    <div className="bd-check" data-tone={line.tone} role="status">
      <span className="bd-box" aria-hidden="true">
        {MARK[line.tone]}
      </span>
      <div>
        <b className={line.tone === "ok" ? "hl" : undefined}>{line.title}</b>
        <span>{line.detail}</span>
      </div>
    </div>
  );
}

function Assignments() {
  const assignments = useStudentAssignments();
  if (!assignments.data?.length) return null;
  return (
    <section className="hw-list">
      <h2 className="lbl">Assignments</h2>
      <ul aria-label="Assignments">
        {assignments.data.map((a) => (
          <li key={a.id}>
            <Link className="qa" to={`/assignments/${a.id}`}>
              <b dir="auto">{a.title}</b>
              <span>
                Due {dueLabel(a.dueAt)}
                {" · "}
                {a.submitted ? "Handed in" : a.state === "due" ? "Not handed in" : "To do"}
                {a.late && <span className="hw-late">Late</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Published Session summaries, newest first; hidden until there is one. */
function Summaries() {
  const list = useStudentSummaries();
  if (!list.data?.length) return null;
  return (
    <section className="st-summaries">
      <h2 className="st-h2">Session summaries</h2>
      <div className="quick">
        {list.data.map((s) => (
          <Link key={s.sessionId} className="qa" to={`/summaries/${s.sessionId}`}>
            <b>{longDate(s.date)}</b>
            <span>Session at {s.start}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/** A plain read page for one published Session summary. */
function SummaryRead() {
  const sessionId = Number(useParams().sessionId);
  // The browser's language by default; the server falls back to the source when there's no translation.
  const [lang, setLang] = useState(() => navigator.language);
  const summary = useStudentSummary(sessionId, lang);
  return (
    <>
      <Link className="st-back" to="/">← Today</Link>
      {summary.isPending ? null : summary.error ? (
        <p className="empty">This summary isn’t available.</p>
      ) : (
        <>
          <p className="bd-course">Session summary</p>
          <h1 className="bd-title">{longDate(summary.data.date)}</h1>
          {summary.data.languages.length > 0 && (
            <label className="field">
              <span>Language</span>
              <select value={summary.data.language ?? ""} onChange={(e) => setLang(e.target.value)}>
                <option value="">Original</option>
                {summary.data.languages.map((l) => (
                  <option key={l} value={l}>{languageName(l)}</option>
                ))}
              </select>
            </label>
          )}
          <SummaryView markdown={summary.data.markdown} />
        </>
      )}
    </>
  );
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h1 className="tab-title">
        <span className="hl">{title}</span>
      </h1>
      <p className="empty">{children}</p>
    </>
  );
}

function Welcome() {
  return (
    <main className="flow">
      <p className="eyebrow">Class Connect</p>
      <h1>Scan the code on the board</h1>
      <p>
        Point your phone camera at the QR code your Lecturer shows. The first time, you’ll enter your student ID;
        after that, one scan checks you in.
      </p>
    </main>
  );
}

/** "ar" → "العربية", in the language's own name where the browser knows it. */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
