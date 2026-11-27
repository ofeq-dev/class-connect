import { Link, NavLink, Route, Routes, useLocation } from "react-router";
import { checkInLine } from "../attendance";
import { useLiveEvents } from "../live";
import { longDate, useStudentMe } from "./queries";

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
          <Route
            path="comment"
            element={
              <Empty title="Message the Lecturer">
                Soon you can send your Lecturer a note here, with your name or anonymously.
              </Empty>
            }
          />
          <Route
            path="mine"
            element={
              <Empty title="Your comments">Nothing sent yet. Only you and the Lecturer see what you write.</Empty>
            }
          />
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
      <div className="quick">
        <Link className="qa" to="/comment">
          <b>Message the Lecturer</b>
          <span>With your name or anonymously</span>
        </Link>
      </div>
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
