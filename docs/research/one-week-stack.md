# Hosting, real-time and data stack that ships in a week

Research for [#3](https://github.com/ofeq-dev/class-connect/issues/3). Sources read 2026-11-23; free tiers change often, so re-check the linked pages before committing.

**Question.** Which stack lets one developer (with AI coding agents) ship a hosted, phone-first web app in one week with:

- real-time updates (live comments, polls, the attendance list),
- a small relational-ish database,
- file uploads (lecture recordings up to about 1 GB, homework files),
- background jobs for LLM calls,
- a reliable public IP for each request, IPv4 and IPv6, so a **Check-in** can be matched against the **Classroom network** (ADR 0001: same IPv4 `/24` or same IPv6 `/64` as the **Lecturer**'s device)?

## TL;DR

- **Recommended: a plain Node server (Hono) + SQLite + Server-Sent Events, on one Fly.io Machine with a volume.** Read the client IP from `Fly-Client-IP`. Fly sets that header itself and recommends it over `X-Forwarded-For` [^fly-headers]. Fly also gives every app IPv6 and shared IPv4 at no cost [^fly-net]. The Free plan gives $5 of usage a month once a card is added [^fly-free], and one small Machine costs about $2.19 a month [^fly-pricing].
- **Runner-up: Cloudflare Workers + Durable Objects + R2.** You get a free plan, IPv6 everywhere, and `CF-Connecting-IP` [^cf-headers]. The cost is a programming model the agents will be less sure of, plus a 10 ms CPU limit on the free plan [^cf-wlimits].
- **Backend-as-a-service options each break one hard requirement on the free tier:**
  - **Supabase:** 50 MB file cap [^supa-files]. Its documented IP recipe trusts the leftmost, spoofable `X-Forwarded-For` entry [^supa-secure] [^supa-xff].
  - **Firebase:** neither Cloud Functions nor Cloud Storage is available on the Spark plan [^fb-plans] [^fb-storage].
  - **Convex:** the client IP is available only since `convex@1.38.0`, and how it is derived is not documented [^cx-changelog] [^cx-meta]. Upload POSTs time out after 2 minutes [^cx-upload].
  - **PocketBase:** a credible "fast CRUD" alternative, but it is pre-1.0 [^pb-readme] and hides the architecture we need to draw.
- **The IP family needs a decision, whatever the stack.** On a dual-stack host (Fly, Cloudflare), the Lecturer's laptop and a Student's phone can reach the server over different IP families. The `/24`-or-`/64` rule then compares unlike things. See [IP family](#ip-family-a-design-issue-every-stack-shares).

## How "reliable client IP" works behind a proxy

Every option here puts a proxy or CDN in front of the code. The TCP peer the app sees is therefore the proxy, and the client address arrives in a header:

- **`X-Forwarded-For` (XFF)** is a list. Each proxy *appends* the address it received the request from. The leftmost entry is whatever the client sent first, so it is "untrustworthy and not for security-related purposes". A safe parser takes the entry added by the last trusted proxy, counting from the right [^mdn-xff].
- **A single-value header set by the platform's own edge** (`Fly-Client-IP`, `CF-Connecting-IP`, Railway's `X-Real-IP`) is safe *if* the edge overwrites any copy the client sent. Only Vercel and Cloudflare state this outright (details per host below).

For a Check-in, a spoofed IP lets a Student check in from home by claiming the classroom's address. That is the forwarded-link attack ADR 0001 relies on the network check to stop. **The code must therefore read the platform header, never the leftmost XFF entry.**

### IP family: a design issue every stack shares

ADR 0001 matches "same IPv4 `/24`, or same IPv6 `/64`". Two cases follow:

- **IPv4-only host** (Render [^render-ipv6], and Railway inbound per a staff reply [^rail-ipv6]): every phone connects over IPv4, usually through the campus NAT pool, and only the `/24` rule ever applies.
- **Dual-stack host** (Fly gives an IPv6 and a shared IPv4 address by default [^fly-net]; Cloudflare serves IPv6 for all domains [^cf-headers]): clients prefer IPv6 when they have it and fall back to IPv4 (Happy Eyeballs, RFC 8305 [^rfc8305]). The Lecturer's laptop might arrive over IPv6 while a Student's phone, on the same Wi-Fi, arrives over IPv4.

Options, all cheap:

1. Record **both** of the Lecturer's addresses when the Session opens. Two extra fetches from the browser, one to an A-record-only hostname and one to an AAAA-only hostname, do this on Fly with a custom domain. Then match a Student on whichever family their request arrived over.
2. Serve the app from an IPv4-only hostname. This loses nothing if the campus NATs IPv4.

This belongs to the **network test mode** and measurement tickets on #1. It is flagged here because it shapes the "client address" seam described under [Architecture seams](#architecture-seams-for-the-recommended-stack).

## Backends compared

### Supabase (Postgres + Realtime + Storage + Edge Functions)

- **Real-time:** Realtime over WebSockets. The Free plan allows 200 concurrent connections and 100 messages/s [^supa-rt], which is plenty for one class.
- **Database:** Postgres, 500 MB on Free [^supa-pricing].
- **Uploads:** global file size limit of **50 MB on Free**. Pro raises it to 500 GB [^supa-files]. TUS resumable uploads are recommended above 6 MB [^supa-resumable]. Free also has only 1 GB of file storage in total [^supa-pricing]. **A 1 GB recording does not fit on Free.**
- **Background jobs:** Edge Functions, with 150 s wall clock and 2 s CPU on Free [^supa-fn]. That is enough for one LLM call each.
- **Client IP:** the docs say to read `split_part(request.headers->>'x-forwarded-for', ',', 1)`, the *first* entry [^supa-secure]. A user showed that sending `X-Forwarded-For: spoofed` makes that function return `spoofed`. The real IP is appended after it, and `cf-connecting-ip` carried the true address. The discussion is unanswered [^supa-xff]. **The documented method is spoofable.** Relying on `cf-connecting-ip` depends on undocumented infrastructure.
- **Free-tier catch:** projects pause after 1 week of inactivity [^supa-pricing].
- **Architecture clarity:** medium. Rules end up split across RLS policies, SQL functions and Edge Functions, which is hard to draw as components with seams.

### Firebase (Firestore + Cloud Functions + Cloud Storage)

- **Real-time:** Firestore listeners. Spark includes 50K reads/day, 20K writes/day and 1 GiB stored [^fb-pricing].
- **Uploads:** Cloud Storage **requires the Blaze plan**, even for default buckets. On Spark, calls return 402/403 [^fb-storage].
- **Background jobs and server code:** Cloud Functions are available only on Blaze [^fb-plans].
- **Client IP:** only server code sees it. In Cloud Functions it comes from `X-Forwarded-For`, where "the first IP in this list is *generally* the IP of the client" [^gcf-headers]. That is the leftmost entry, with the same spoofing caveat [^mdn-xff].
- **Free-tier catch:** effectively Blaze-only (card required) for this app, because uploads and the IP check both need paid-plan products.
- **Architecture clarity:** medium-low. The data model is document-shaped (not relational), and rules live in Security Rules.

### Convex (reactive DB + functions + file storage)

- **Real-time:** reactive queries are the core feature, so the strongest real-time story of the five.
- **Database:** document store with relations by ID. Free: 0.5 GB of data, 1 GB file storage, 1M function calls a month [^cx-limits].
- **Uploads:** upload URLs have no file-size limit, but "upload POST request has a 2 minute timeout" [^cx-upload]. 1 GB in 2 minutes needs about 67 Mbit/s of sustained upload from a phone. HTTP actions cap multipart bodies at 20 MiB [^cx-http].
- **Background jobs:** the scheduler plus actions (Node actions up to 10 min [^cx-limits]). The pricing page lists crons on Free [^cx-pricing].
- **Client IP:** until May 2026 it was unavailable in queries, mutations and actions (issue #130) [^cx-130]. `convex@1.38.0` added `ctx.meta.getRequestMetadata()`, which returns `{ ip, userAgent, requestId }` in mutations and actions, with `ip` null for scheduled jobs [^cx-changelog] [^cx-meta]. **How `ip` is derived (which proxy header, whether it can be spoofed) is not documented.** The feature is 6 months old.
- **Hosting:** Convex hosts only the backend. The frontend needs a static host as well (Vercel, Cloudflare Pages).
- **Architecture clarity:** good inside Convex (queries, mutations and actions are explicit), but the IP check depends on a young, undocumented API.

### PocketBase (single Go binary: SQLite + realtime + files + auth)

- **Real-time:** subscriptions over SSE, filtered by collection rules [^pb-rt].
- **Database:** SQLite (on the server's disk).
- **Uploads:** file fields default to about 5 MB and the limit is configurable per field. Local disk or S3-compatible storage [^pb-files].
- **Background jobs:** `cronAdd()` jobs [^pb-cron]. LLM calls go in hooks. JS hooks run in an embedded ES5 engine (goja), "not a Node.js or browser environment" [^pb-js], so agents can't use npm SDKs there. Go hooks need a custom build.
- **Client IP:** `e.RealIP()` reads the header(s) configured in *Settings → TrustedProxy* and falls back to the TCP peer [^pb-go] [^pb-prod]. On Fly, set it to `Fly-Client-IP`.
- **Hosting:** needs a persistent disk, so Fly (volume) and not Render Free (ephemeral) [^render-free].
- **Maturity:** "full backward compatibility is not guaranteed before reaching v1.0.0" [^pb-readme].
- **Architecture clarity:** low for our purposes. PocketBase is one opaque box, and the domain logic (Check-in, Classroom network match) hides inside hooks.

### Plain Node: Hono + SQLite + SSE (or WebSocket)

- **Real-time:** an in-process SSE broadcaster per Session. With one Machine there is no pub/sub to run.
- **Database:** SQLite file on a volume.
- **Uploads:** stream the request body to disk. Fly Free volumes go up to 5 GB each [^fly-free] at $0.15/GB-month [^fly-pricing], room for a few 1 GB recordings. If space runs out, switch the storage adapter to S3-compatible object storage.
- **Background jobs:** a `jobs` table plus an in-process worker loop. LLM calls are network-bound, so a single process copes.
- **Client IP:** a single function in our code. On Fly it reads `Fly-Client-IP` [^fly-headers]. Hono's `getConnInfo` gives the raw socket address for local dev, with per-runtime adapters [^hono-conninfo].
- **Architecture clarity:** highest. Every component and seam is our own code and appears on the component diagram (see below).
- **Cost:** the most code to write. That suits AI agents well, because Express/Hono + SQLite is heavily represented in their training data.

## Hosts compared

| Host | Free tier (today) | Sleeps / cold start | WebSockets / SSE | Upload limit | Client IP header | Spoofable? | Inbound IPv6 |
|---|---|---|---|---|---|---|---|
| **Fly.io** | Free plan: $1 one-off credit without a card (7 days); **$5/month with a card**; up to 3 Machines, volumes ≤ 5 GB [^fly-free]. 256 MB Machine about $2.19/mo [^fly-pricing] | Optional autostop. Cold start "about 2 seconds or more"; `suspend` resumes in "a few hundred milliseconds" [^fly-autostop] | Yes (plain TCP/HTTP proxy) | No limit found in the docs; verify | `Fly-Client-IP` (set by Fly Proxy). XFF's rightmost entry is the app's own IP [^fly-headers] | Fly recommends `Fly-Client-IP` over XFF to avoid spoofing [^fly-headers]. Overwriting a client-sent copy is implied, not stated | **Yes**, dedicated Anycast IPv6 free [^fly-net] |
| **Render** | 750 free instance-hours/month; free Postgres expires after 30 days [^render-free] | Spins down after **15 min** idle; spin-up "about one minute"; **filesystem wiped** on spin-down [^render-free] | Yes [^render-ws] | Not documented | XFF. Render's CEO said "we set the first IP in the list to the real client IP" (2021), but a user reports the proxy only appends [^render-xff] | **Undocumented and disputed.** Test before trusting | **No** (open feature request) [^render-ipv6] |
| **Railway** | Free plan: $1/month usage, 0.5 GB RAM per service, 1 volume (0.5 GB), 1 bucket (10 GB); 30-day trial with $5 [^rail-free] | Sleeps after 5–10 min without *outbound* traffic [^rail-free] | WebSockets over HTTP/1.1, no idle limit [^rail-specs] | Request body must finish uploading within 5 min [^rail-specs] | `X-Real-IP` [^rail-specs] | Overwrite not stated in the docs ("subject to change") [^rail-specs] | Inbound IPv4 only per staff reply; outbound IPv6 is opt-in [^rail-ipv6] [^rail-out] |
| **Vercel** (Hobby) | Functions with 300 s max duration [^vercel-fn] | Serverless (per-request instances) | WebSockets in **public beta**. Connections close at max duration and reconnects may land on any instance, so shared state must live elsewhere [^vercel-ws] | **4.5 MB** request body (20 MiB beta on Node) [^vercel-fn] | `x-forwarded-for` / `x-real-ip` (identical) [^vercel-headers] | **No.** Vercel overwrites XFF "to prevent IP spoofing" [^vercel-headers] | Not documented on official pages; verify |
| **Cloudflare** (Workers Free) | 100k requests/day, **10 ms CPU**/request [^cf-wlimits]; Durable Objects (SQLite) on Free, 100k req/day [^cf-do]; R2 10 GB-month free [^cf-r2]; Queues 10k ops/day [^cf-queues] | No sleeping; DO WebSocket Hibernation avoids duration charges [^cf-do] | WebSockets via Durable Objects [^cf-do] | **100 MB** request body on Free/Pro zones [^cf-wlimits]. Large files go straight to R2 (≤ 4.995 GiB per PUT/part, multipart up to 5 TiB) [^r2-limits] | `CF-Connecting-IP` (plus `CF-Connecting-IPv6` with Pseudo-IPv4) [^cf-headers] | **No** at the edge. `x-real-ip` is stripped when no Worker subrequest is involved [^cf-headers] | **Yes**, free for all domains [^cf-headers] |

Where each backend deploys:

- **Supabase, Firebase and Convex** are hosted services. The frontend goes on any static host.
- **PocketBase** needs a disk: Fly (volume) or Railway (0.5 GB volume on Free).
- **Plain Node + SQLite** also needs a disk: Fly. Railway works but sleeps and has a 0.5 GB volume. Render Free loses the SQLite file on spin-down [^render-free]. Vercel has no persistent disk and a 4.5 MB body limit.

## Comparison

| | Real-time | DB | 1 GB upload on free tier | LLM jobs | Trustworthy client IP (v4+v6) | Free without card | Architecture clarity | Week-one risk |
|---|---|---|---|---|---|---|---|---|
| **Supabase** | ★★★ Realtime | Postgres 500 MB | ✗ 50 MB cap [^supa-files] | Edge Functions 150 s | ✗ documented recipe trusts leftmost XFF [^supa-xff] | ✓ (pauses after 7 days idle) | ★★ | Medium |
| **Firebase** | ★★★ listeners | Firestore (documents) | ✗ Storage needs Blaze [^fb-storage] | Functions need Blaze [^fb-plans] | ~ XFF in Functions (Blaze only) [^gcf-headers] | ✗ for this app | ★★ | Medium |
| **Convex** | ★★★ reactive | Documents 0.5 GB | ~ no size cap, but 2-min upload timeout; 1 GB storage total [^cx-upload] [^cx-limits] | Scheduler + actions | ~ `getRequestMetadata().ip` since 1.38, derivation undocumented [^cx-meta] | ✓ | ★★ (backend only) | Medium |
| **PocketBase on Fly** | ★★ SSE | SQLite | ✓ configurable, to volume | cron + ES5 hooks | ✓ `RealIP()` + `Fly-Client-IP` [^pb-go] [^fly-headers] | ✗ (Fly card for $5/mo) | ★ (one box) | Low–medium (pre-1.0) |
| **Hono + SQLite + SSE on Fly** | ★★ SSE (we write it) | SQLite | ✓ stream to volume (≤ 5 GB) [^fly-free] | jobs table + worker | ✓ `Fly-Client-IP`, IPv6 + IPv4 [^fly-headers] [^fly-net] | ✗ (Fly card for $5/mo) | ★★★ all ours | Low (more code, familiar code) |
| **Workers + DO + R2** | ★★★ DO WebSockets | DO SQLite | ✓ presigned/multipart to R2 [^r2-limits] | Queues 10k/day | ✓ `CF-Connecting-IP`, IPv6 default [^cf-headers] | ✓ | ★★★ (DO per Session is a natural component) | Medium (unfamiliar model, 10 ms CPU) |

## Recommendation

**Build a plain Node + Hono + SQLite + SSE server, deployed as one Fly.io Machine with a volume.**

- **Why:**
  - It is the only option that meets all five requirements on a near-free tier: about $2.19/mo Machine plus $0.15/GB volume, inside the Free plan's $5 monthly credit once a card is added [^fly-free] [^fly-pricing].
  - It gets the IP check right without relying on undocumented behaviour: `Fly-Client-IP` [^fly-headers], native IPv6 + IPv4 [^fly-net].
  - Every architectural seam is our own code, which the graded architecture docs can show directly.
  - One process means real-time needs no broker: SSE fan-out per Session in memory.
- **Deployment settings:**
  - Run one Machine (`fly deploy --ha=false` [^fly-free]), so the in-memory SSE hub and SQLite stay consistent.
  - Set `auto_stop_machines = "suspend"` (or `min_machines_running = 1` on demo day) [^fly-autostop].
- **Fallback if no card is available:** Cloudflare Workers + one Durable Object per Session + R2 + Queues. It has the same trustworthy-IP property [^cf-headers], and its pieces also map cleanly onto components, but it costs more agent time to get right.
- **Not chosen:**
  - **Supabase:** spoofable documented IP recipe, 50 MB file cap.
  - **Firebase:** needs Blaze for both uploads and the IP check.
  - **Convex:** the IP API is new and undocumented; 2-min upload timeout.
  - **PocketBase:** opaque for the architecture docs, pre-1.0.

### Architecture seams for the recommended stack

These are candidate modules (deep modules behind small interfaces) for the architecture ticket. Names follow `GLOSSARY.md`.

| Module | Interface | Adapters |
|---|---|---|
| **ClientAddress** | `fromRequest(req) → {ip, family}` | Fly (`Fly-Client-IP`), local dev (`getConnInfo`) [^hono-conninfo], test fake. The only place that knows about proxies. |
| **ClassroomNetwork** | `matches(lecturerAddrs, studentAddr) → bool` | Pure function: `/24` and `/64` per ADR 0001. Trivially unit-tested. |
| **Check-in service** | Session + QR token + ClientAddress → accepted / refused / Manual mark | — |
| **Realtime hub** | `publish(sessionId, event)`, `subscribe(sessionId)` → SSE stream | In-memory now; could become Redis or Durable Objects later without touching callers. |
| **FileStore** | `put(stream)`, `get(id)` | Local volume now, S3/R2 later. |
| **JobQueue + LLM client** | SQLite `jobs` table, worker loop | OpenRouter client. |

## To verify on day one

- **Header overwrites.** Deploy a 5-line echo route and `curl -H 'Fly-Client-IP: 1.2.3.4' -H 'X-Forwarded-For: 1.2.3.4'` it. Confirm Fly overwrites both, which its docs imply but don't state [^fly-headers]. Do the same for any other host chosen.
- **Large uploads.** Upload a 1 GB file through Fly's proxy from a phone. No body-size or duration limit was found in Fly's docs.
- **IP family.** From the real classroom network, record which family the Lecturer's laptop and a phone use against a dual-stack host. This feeds ADR 0001's "must be measured before the demo".

## Sources

[^fly-headers]: Fly.io, "Request headers": https://fly.io/docs/networking/request-headers/
[^fly-net]: Fly.io, "Public networking / services" (IPv6, shared IPv4): https://fly.io/docs/networking/services/
[^fly-free]: Fly.io, "Free plan": https://fly.io/docs/about/free-trial/
[^fly-pricing]: Fly.io, "Resource pricing": https://fly.io/docs/about/pricing/
[^fly-autostop]: Fly.io, "Autostop/autostart Machines": https://fly.io/docs/launch/autostop-autostart/
[^render-free]: Render, "Deploy for free": https://render.com/docs/free
[^render-ws]: Render, "WebSockets on Render": https://render.com/docs/websocket
[^render-xff]: Render feedback board, "Send the correct X-Forwarded-For" (reply by Anurag Goel, Render, 2021): https://feedback.render.com/features/p/send-the-correct-xforwardedfor
[^render-ipv6]: Render feedback board, "IPv6 Support" (open, comments through April 2026): https://feedback.render.com/features/p/ipv6-support
[^rail-free]: Railway, "Free plan": https://docs.railway.com/reference/pricing/free-trial
[^rail-specs]: Railway, "Public networking: specs & limits": https://docs.railway.com/networking/public-networking/specs-and-limits
[^rail-out]: Railway, "Outbound networking" (opt-in outbound IPv6): https://docs.railway.com/networking/outbound-networking
[^rail-ipv6]: Railway Central Station, "IPv6 feature flag" (staff reply: inbound remains IPv4; community source): https://station.railway.com/questions/i-pv6-feature-flag-can-t-connect-to-sup-38b41ca1
[^vercel-headers]: Vercel, "Request headers": https://vercel.com/docs/headers/request-headers
[^vercel-fn]: Vercel, "Functions limitations": https://vercel.com/docs/functions/limitations
[^vercel-ws]: Vercel KB, "Do Vercel Functions support WebSocket connections?": https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections
[^cf-headers]: Cloudflare, "Cloudflare HTTP headers": https://developers.cloudflare.com/fundamentals/reference/http-headers/
[^cf-wlimits]: Cloudflare, "Workers limits": https://developers.cloudflare.com/workers/platform/limits/
[^cf-do]: Cloudflare, "Durable Objects pricing": https://developers.cloudflare.com/durable-objects/platform/pricing/
[^cf-r2]: Cloudflare, "R2 pricing": https://developers.cloudflare.com/r2/pricing/
[^r2-limits]: Cloudflare, "R2 limits": https://developers.cloudflare.com/r2/platform/limits/
[^cf-queues]: Cloudflare, "Queues pricing": https://developers.cloudflare.com/queues/platform/pricing/
[^supa-pricing]: Supabase, "Pricing": https://supabase.com/pricing
[^supa-files]: Supabase, "Storage upload limits": https://supabase.com/docs/guides/storage/uploads/file-limits
[^supa-resumable]: Supabase, "Resumable uploads": https://supabase.com/docs/guides/storage/uploads/resumable-uploads
[^supa-rt]: Supabase, "Realtime limits": https://supabase.com/docs/guides/realtime/limits
[^supa-fn]: Supabase, "Edge Functions limits": https://supabase.com/docs/guides/functions/limits
[^supa-secure]: Supabase, "Securing your API" (client IP from `x-forwarded-for`): https://supabase.com/docs/guides/api/securing-your-api
[^supa-xff]: Supabase GitHub discussion #34647, "Is x-forwarded-for safe?": https://github.com/orgs/supabase/discussions/34647
[^fb-pricing]: Firebase, "Pricing": https://firebase.google.com/pricing
[^fb-plans]: Firebase, "Firebase pricing plans": https://firebase.google.com/docs/projects/billing/firebase-pricing-plans
[^fb-storage]: Firebase, "Default bucket and billing requirements for Cloud Storage for Firebase after September 2024": https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024
[^gcf-headers]: Google Cloud, "Request headers in Cloud Functions": https://cloud.google.com/functions/docs/reference/headers
[^cx-pricing]: Convex, "Pricing": https://www.convex.dev/pricing
[^cx-limits]: Convex, "Limits": https://docs.convex.dev/production/state/limits
[^cx-upload]: Convex, "Uploading and storing files": https://docs.convex.dev/file-storage/upload-files
[^cx-http]: Convex, "HTTP actions": https://docs.convex.dev/functions/http-actions
[^cx-130]: Convex backend issue #130, "Remote IP address in queries/mutations/actions" (closed 2026-05-08): https://github.com/get-convex/convex-backend/issues/130
[^cx-changelog]: Convex npm package changelog, 1.38.0: https://cdn.jsdelivr.net/npm/convex@1.42.3/CHANGELOG.md
[^cx-meta]: Convex source, `src/server/meta.ts` (`RequestMetadata`): https://cdn.jsdelivr.net/npm/convex@1.42.3/src/server/meta.ts
[^pb-rt]: PocketBase, "API Realtime": https://pocketbase.io/docs/api-realtime/
[^pb-files]: PocketBase, "Files upload and handling": https://pocketbase.io/docs/files-handling/
[^pb-cron]: PocketBase, "JS jobs scheduling": https://pocketbase.io/docs/js-jobs-scheduling/
[^pb-js]: PocketBase, "Extend with JavaScript: overview": https://pocketbase.io/docs/js-overview/
[^pb-go]: PocketBase, "Extend with Go: routing" (`RemoteIP` vs `RealIP`): https://pocketbase.io/docs/go-routing/
[^pb-prod]: PocketBase, "Going to production" (reverse proxy, user IP proxy headers): https://pocketbase.io/docs/going-to-production/
[^pb-readme]: PocketBase README: https://github.com/pocketbase/pocketbase
[^hono-conninfo]: Hono, "ConnInfo helper": https://hono.dev/docs/helpers/conninfo
[^mdn-xff]: MDN, "X-Forwarded-For": https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For
[^rfc8305]: IETF RFC 8305, "Happy Eyeballs Version 2": https://www.rfc-editor.org/rfc/rfc8305
