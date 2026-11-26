# Development

Node 22.12 or newer.

```sh
npm install
cp .env.example .env          # then fill in the two secrets:
npm run hash-password -- <pw> # → LECTURER_PASSWORD_HASH
                              # COOKIE_SECRET: any long random string
npm run dev                   # Hono on :3000, Vite on :5173 (proxies /api and /healthz)
```

Open `http://localhost:5173/lecturer` and sign in.

| Command | What it does |
|---|---|
| `npm run check` | Type check, lint (including the module-boundary rule), every test. CI runs it on each PR. |
| `npm test` | Vitest in watch mode. |
| `npm run build` | Front end to `dist/client`, server bundle to `dist/server`. |
| `npm start` | Runs the built server (migrations apply at startup, then it listens on `127.0.0.1`). |
| `npm run db:generate -- --name <name>` | Generates a migration from the module schema files. Migrations are additive only. |

## Where things go

- `src/server/<module>/`: one folder per module. Feature modules (Course, Attendance, Feedback, Summaries, Homework) and infrastructure (`clock`, `live-events`, `llm`, `jobs`, `files`, `db`). Each module's `index.ts` is its interface; a lint rule stops code outside a module importing anything else from it. A module's tables live in its `schema.ts`.
- `src/server/http/`: thin Hono routes that call module interfaces.
- `src/server/testing/`: `makeTestApp`, the fakes and the builders (`docs/testing-strategy.md`).
- `src/client/`: the React app. `live.ts` maps each Live events notice type to the queries it refetches; add an entry when the server gains a notice type (the type check enforces it).
- `src/shared/`: types both sides use.

Agents branch from `dev` and open PRs into `dev`.

Put `Closes #<ticket>` in the PR body. A merge into `dev` closes that ticket (the `close tickets on dev merge` workflow), which unblocks the tickets waiting on it.
