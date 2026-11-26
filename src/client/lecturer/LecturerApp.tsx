import { useQuery } from "@tanstack/react-query";
import { api, ApiError, ok } from "../api";
import { CoursesPage } from "./CoursesPage";
import { SignInPage } from "./SignInPage";

export function LecturerApp() {
  const me = useQuery({
    queryKey: ["lecturer", "me"],
    queryFn: async () => ok(await api.api.lecturer.me.$get()),
  });

  if (me.isPending) return null;
  if (me.error instanceof ApiError && me.error.status === 401) return <SignInPage />;
  if (me.error) return <p className="page error">{me.error.message}</p>;
  return <CoursesPage />;
}
