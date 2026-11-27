import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api, ok } from "../api";

export function SignInPage() {
  const client = useQueryClient();
  const [password, setPassword] = useState("");
  const signIn = useMutation({
    mutationFn: async () => ok(await api.api.lecturer.session.$post({ json: { password } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["lecturer", "me"] }),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    signIn.mutate();
  }

  return (
    <main className="signin">
      <form className="sec" onSubmit={submit}>
        <div className="sec-head">
          <h2>
            <span className="hl">Class Connect</span>
          </h2>
        </div>
        <label className="field">
          <span>Lecturer password</span>
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {signIn.error && <p className="error">{signIn.error.message}</p>}
        <div className="row">
          <button className="btn" type="submit" disabled={!password || signIn.isPending}>
            Sign in
          </button>
        </div>
      </form>
    </main>
  );
}
