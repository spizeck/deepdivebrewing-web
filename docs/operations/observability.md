# Observability & Error Handling

How production failures surface, what gets logged, and how to correlate a
user-reported problem with server logs. The app uses **Vercel runtime logs**
for detail and **Sentry** (server + browser, Issues #85/#92) for proactive
error alerting — plus existing analytics for product questions.

## Where the signals live

| Signal | Where | Purpose |
| --- | --- | --- |
| Error monitoring | Sentry project (`deepdivebrewing-web`) | Proactive alerting + grouping for actionable server and browser failures |
| Server logs | Vercel dashboard → project → **Logs** (runtime) | API-route and render failures, operational events, full error detail |
| Build logs | Vercel deployment → **Build Logs** | Prerender/static-generation failures |
| Admin audit logs | Firestore `adminAuditLogs` collection | Who did which admin action (business audit, not error tracking) |
| GA4 / Vercel Analytics / Speed Insights | respective dashboards | Product and traffic questions only — **not** error monitoring |
| Browser smoke tests | CI `Verify` job | Catch unhandled page errors, console errors, and 5xx/4xx responses on every PR before deploy |

## Error monitoring (Sentry)

Server **and** browser capture via `@sentry/nextjs` (Issue #92 modernized the
server-only #85 setup). Sentry exists because Vercel has no built-in
error-alerting path without paid log drains, and custom email/webhook
alerting would reinvent grouping/dedup and risk alert storms.

Layout:

- `sentry.server.config.ts` — `Sentry.init` for the nodejs server runtime,
  loaded by `instrumentation.ts` `register()` (`NEXT_RUNTIME === "nodejs"`).
- `instrumentation-client.ts` — `Sentry.init` for the browser, run once
  before hydration; also exports `onRouterTransitionStart`.
- `instrumentation.ts` `onRequestError` — delegates to
  `Sentry.captureRequestError`, the supported capture path for uncaught
  render/RSC/route-handler errors, tagged `event: next.request_error`.
- `app/error.tsx` + `app/global-error.tsx` — error boundaries report the
  error they catch (`Sentry.captureException` with the error `digest`).
- `next.config.ts` — `withSentryConfig` (from `@sentry/nextjs/config`)
  uploads source maps and stamps the release at build time.
- `lib/monitoring.ts` — the curated `logError` funnel (unchanged role).
- `lib/monitoring-shared.ts` — sanitization and env gating shared by both
  init paths; browser-safe (no server-only imports).

### What is reported

- **Server:** every `logError` call reports its event — the funnel in
  `lib/log.ts` covers all current and future call sites (persistence
  failures, email send failures, unexpected route errors,
  misconfigurations). `onRequestError` additionally reports uncaught server
  render/route errors that bypass `logError` — once, via the SDK.
- **Browser:** uncaught exceptions, unhandled rejections, and error-boundary
  failures that would otherwise be invisible in Vercel server logs.
- An SSR failure that surfaces in `app/error.tsx` may produce a paired
  server event (`next.request_error`) and browser event (boundary capture).
  They have different mechanisms/platforms and group separately — this is
  the standard supported pattern, not a bug.

### What is never reported

- `logInfo`/`logWarn` events — routine denials (`admin_auth.denied`),
  expected conditions, and audit noise stay in Vercel logs only.
- Validation failures, honeypot hits, rate limits, 401/403/404s — those
  paths never call `logError`; Next.js also filters `notFound()`/`redirect()`
  control flow out of `onRequestError`.
- PII and secrets: `sendDefaultPii: false` on both inits, and `scrubEvent`
  (`beforeSend`) removes request headers, cookies, bodies, query strings
  (from request URLs, the browser page URL, and the Next.js request-path
  context), user context, breadcrumbs, and stack-frame local variables.
  Log context is already key-filtered in `lib/log.ts` before it is ever
  forwarded.
- **Raw exceptions on the curated funnel**: provider/runtime error objects
  are uncontrolled text — they can embed emails, tokens, URLs with
  credentials, or customer values. `sanitizeError` sends a reduced synthetic
  `Error` instead: name, code, a message with emails/tokens/URL-queries/
  long-opaque-strings redacted and capped at 300 chars, and a rebuilt stack
  whose frames are individually scrubbed. SDK-captured errors
  (`onRequestError`, browser) keep their real stacks for source mapping;
  `beforeSend` scrubs their message/type text and strips frame locals. The
  full original error still lands in Vercel logs per the logging policy.
- **Breadcrumbs**: `maxBreadcrumbs: 0` and the browser's `Breadcrumbs`
  integration is removed entirely, so console/UI/network crumbs are never
  collected rather than scrubbed after the fact — they could capture
  navigation URLs with query strings, console output, or fetch targets.
- **No Session Replay** (no replay integration is configured — DOM, input,
  and screen recording are off by construction), no profiling, and no
  performance tracing (`tracesSampleRate: 0`). Vercel Analytics/Speed
  Insights already cover performance.
- **No release-health session tracking**: the SDK's default session
  integrations are removed (`BrowserSession` in `instrumentation-client.ts`,
  `ProcessSession` in `sentry.server.config.ts`), so Sentry receives error
  events only — no session envelopes are emitted between exceptions. (SDK
  v10 has no `autoSessionTracking` option; integration removal is the
  supported mechanism.)

### Issue grouping

Curated `logError` events fingerprint as `["deepdivebrewing", <event>]` —
every occurrence of a failure class groups into one issue, so a "new issue"
alert fires once per failure mode. SDK-captured errors (`onRequestError`,
browser exceptions) get **no custom fingerprint**: Sentry's normal grouping
(type + stack) keeps distinct failures distinct while the `event` tag
remains available for filtering.

### Environment behavior and configuration

Reporting is **production-only** on both sides:

- **Server:** `monitoringEnabled` requires `VERCEL_ENV=production`,
  `NEXT_RUNTIME=nodejs` (request-serving only — never `next build`), and a
  configured DSN.
- **Browser:** `clientMonitoringEnabled` requires `NEXT_PUBLIC_SENTRY_DSN`
  and `NEXT_PUBLIC_VERCEL_ENV=production` (Vercel publishes
  `NEXT_PUBLIC_VERCEL_*` to client builds automatically). Preview deploys
  cannot report even if the DSN were scoped too broadly.

Events carry `environment` (`VERCEL_ENV` / `NEXT_PUBLIC_VERCEL_ENV`) and
`release` (the deployment's Git commit SHA — `VERCEL_GIT_COMMIT_SHA` /
`NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA`), matching the build-time release the
source maps are uploaded under.

Vercel environment variables (Production scope):

| Variable | Scope | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SENTRY_DSN` | Runtime — inlined into the browser bundle by design | Event ingest DSN for server + browser SDKs. Not a credential — it only identifies where events go. |
| `SENTRY_ORG` | Build time | Org slug for source-map upload (shared team value). |
| `SENTRY_PROJECT` | Build time | Project slug for source-map upload. |
| `SENTRY_AUTH_TOKEN` | Build time — **secret** | Auth for source-map upload. Never exposed to the client bundle, logs, or docs. |
| `SENTRY_DSN` | Legacy — remove after cutover | Pre-#92 server-only variable. Still honored as a fallback so nothing breaks if it outlives the migration; remove it from Vercel once `NEXT_PUBLIC_SENTRY_DSN` is verified live. |

Source maps: `withSentryConfig` uploads maps during `next build` when
`SENTRY_AUTH_TOKEN` is present and deletes them from the served output, so
minified production stacks symbolicate without exposing maps publicly.
Without the token the upload step is disabled entirely — CI, local, and
preview builds need nothing.

CSP: `connect-src` gains exactly one entry — the ingest origin parsed from
the configured `NEXT_PUBLIC_SENTRY_DSN` — so browser events can reach
Sentry. No wildcard Sentry domains; when the DSN is unset nothing is added.

### Alert setup (required post-deployment step)

Alert routing lives in Sentry, not the repo — no notification destination is
hard-coded. After setting the variables above in Vercel (Production scope):

1. Sentry → project **Settings → Alerts → Alert Rules → New Alert Rule**.
2. Condition: **When a new issue is created** (event fingerprinting already
   dedupes repeats into one issue, so this fires once per failure class).
3. Action: notify the project team via email (or the owner's preferred
   destination — do not commit one to the repo).
4. Optionally add a second rule for issue **spikes** (same issue recurring
   >10×/hour) if a noisy failure mode emerges.

### Correlating a Sentry issue to Vercel logs

Each server event carries `event` (the stable log event name) as a tag and
the sanitized log context (e.g. `requestId`, `leadId`) as extras. Search
Vercel **Logs** for the same `event`/`requestId` to see the full error
including stack and provider details. Browser events have no Vercel-log
counterpart — that is the gap this integration fills.

### Testing the integration safely

- **Unit tests** (`tests/lib/monitoring.test.ts`,
  `tests/lib/sentry-config.test.ts`) exercise the funnel, scrubbing, env
  gating, and config invariants without a network.
- **End-to-end server check**: set `NEXT_PUBLIC_SENTRY_DSN` +
  `VERCEL_ENV=production` locally, run `npm run build && npm run start`,
  then trigger a real failure — e.g. temporarily unset `RESEND_API_KEY` and
  submit the trade form (the lead persists, notification fails,
  `trade_inquiry.notification_failed` appears in Sentry). Never point CI or
  preview deploys at the production project.
- **End-to-end browser check**: also set `NEXT_PUBLIC_VERCEL_ENV=production`
  locally, `npm run build && npm run start`, open the site, and throw from
  DevTools (`setTimeout(() => { throw new Error("monitoring probe") })`) —
  an uncaught exception is captured without any app code.
- **TEMPORARY verification endpoint** (remove after the production alert is
  confirmed): `POST /api/admin/monitoring/test` — admin-only (the standard
  `requireAdminActor` bearer-token check; anonymous calls get 401). It emits
  one `monitoring.test_error` `logError` whose synthetic `Error` carries fake
  sensitive values (a test email, bearer token, URL query, opaque token), so
  the resulting Sentry issue proves sanitization as well as delivery and
  alerting. It is a silent no-op outside production (the normal
  `VERCEL_ENV`/`NEXT_RUNTIME`/DSN gate still applies). To verify:
  sign in to `/admin`, copy your ID token, and POST with
  `Authorization: Bearer <token>`; expect `{ "ok": true }`, one
  `monitoring.test_error` line in Vercel logs, one new Sentry issue, and one
  alert. Then remove the route, `lib/monitoring-test.ts`, its test, and this
  note in a cleanup PR.

### Post-deployment verification (Issue #92 cutover)

After the production deploy with the new variables configured:

1. **Server**: POST `/api/admin/monitoring/test` as above; confirm a
   `monitoring.test_error` issue appears in the `sea-saba` org's
   `deepdivebrewing-web` project with `environment=production`, the commit
   SHA as release, a source-mapped stack, and none of the probe's fake
   sensitive values.
2. **Browser**: open the production site in a normal tab and run
   `setTimeout(() => { throw new Error("sentry client probe") })` in
   DevTools; confirm a browser-platform issue with `environment=
   production`, a source-mapped stack, the page URL **without** query
   string, no user context, no breadcrumbs, and no Replay attachment.
3. **Cutover**: once both land correctly, delete `SENTRY_DSN` from Vercel —
   the code honors it only as a fallback — then the fallback in
   `sentryDsn()` can be removed in a later cleanup PR with the temporary
   probe endpoint.

### If Sentry is unavailable or misconfigured

Nothing changes for users: reporting is fire-and-forget, every failure path
is wrapped, and the flush is bounded at 2s. If the DSN is unset or wrong,
capture is a silent no-op (`enabled: false` rather than an unconfigured
SDK). Vercel logs keep the full structured record regardless — monitoring
is a notification layer, never a dependency.

### Disabling / rolling back

Remove `NEXT_PUBLIC_SENTRY_DSN` from Vercel (Production) and redeploy —
reporting stops immediately with no code change (the CSP entry disappears
with it at the next build). To remove the integration entirely, revert the
PRs that introduced `lib/monitoring.ts`, `sentry.server.config.ts`,
`instrumentation-client.ts`, and the `withSentryConfig` wrapper, then
uninstall `@sentry/nextjs`.

## Structured server logs

Server code logs via `lib/log.ts` (`logInfo` / `logWarn` / `logError`), which
emits **single-line JSON** so Vercel's log search can filter reliably:

```json
{"level":"error","event":"trade_inquiry.send_failed","requestId":"vcd::…","error":{"name":"…","message":"…","code":"…"}}
```

- `event` is a stable, dot-namespaced name (`area.outcome`) — search on it.
- `requestId` correlates a request across log lines: it reuses Vercel's
  `x-vercel-id` header when present (so it also joins Vercel's own request
  logs), then `x-request-id`, then a generated id. It appears **in logs
  only** — it is not returned to clients.
- `error` carries normalized `name`/`message`/`code`/`stack` — plain objects
  from providers (e.g. Resend's `{name, message, statusCode}`) are normalized
  instead of stringifying to `[object Object]`.

### Current event names

| Event | Meaning |
| --- | --- |
| `trade_inquiry.persisted` | Inquiry durably written to `tradeLeads` (`leadId`, `venueType`, `requestId`) |
| `trade_inquiry.persistence_failed` | Firestore write failed — the customer saw an error (`requestId` + error) |
| `trade_inquiry.notification_sent` | Resend notification delivered after persistence (`leadId`, `requestId`) |
| `trade_inquiry.notification_failed` | Notification failed/unconfigured **after** the lead was stored — the inquiry is NOT lost; check `TRADE_INQUIRY_TO_EMAIL`/`RESEND_API_KEY` and the `leadId` (`leadId`, `requestId` + error) |
| `trade_inquiry.unexpected` | Unhandled error in the inquiry route |
| `admin_rebuild.misconfigured` | Deploy-hook env var unset (name only — the URL is never logged) |
| `admin_rebuild.hook_failed` | Vercel deploy hook returned non-2xx (`upstreamStatus` only — the body could echo the URL) |
| `admin_rebuild.triggered` | Rebuild triggered successfully (`uid`, `role`) |
| `admin_rebuild.unexpected` | Unhandled error in the rebuild route |
| `admin_auth.denied` | Claims passed but the `adminUsers` record check failed (`uid` + `reason`; warn — rare and security-relevant) |
| `admin_users.{list,create,update,revoke}_failed` | Unhandled errors in administrator management |
| `admin_users.claims_sync_rolled_back` | Custom-claim update failed after a record write and the record write was rolled back |
| `admin_invitation.{delivery_record,reload,audit}_failed` | Post-send bookkeeping failures in the create flow |
| `admin_invitation.resend_step_failed` | A named step in the resend pipeline failed (see `step` field) |
| `admin_invitation.{accept_rollback,accept,resend}_failed` | Invitation lifecycle failures |
| `admin_invitation_email.{misconfigured,send_rejected,send_exception}` | Invitation email send-path failures (`missing` names the unset var) |
| `admin_bootstrap.failed` / `admin_me.unexpected` | Bootstrap and identity-probe failures |

Routine validation and authorization denials (missing bearer token, bad
input, rate limits, honeypot hits) are **not logged** — they are expected
4xx noise.

## What must never be logged

`lib/log.ts` defensively drops context keys that look sensitive
(`authorization`, `cookie`, `token`, `secret`, `password`, `credential`,
`private`, `api_key`, `deploy_hook`, …), but callers must simply never pass
them. Do not log request bodies, auth tokens, `RESEND_API_KEY`,
`FIREBASE_ADMIN_*`, deploy-hook URLs, raw `process.env`, or customer inquiry
content. The full list is in `SECURITY.md` → "Logging and sensitive data".

Context values are primitives only and capped at 300 characters. Invitation
logs use `invitationId`, not email addresses.

## Client-facing errors

API routes answer failures as `{ ok: false, error: "…" }`. Errors marked
`clientSafe` (currently `AdminAuthError` — deliberate messages like
"Requires superadmin role") pass their message and status through; every
other error is logged in full server-side and answered with a generic
fallback plus HTTP 500 via `apiErrorResponse` in `lib/api-error.ts`.
Provider details and stack-derived messages never reach the client.

Unhandled render errors land in `app/error.tsx` (branded fallback with the
error `digest` for support correlation; Next.js still logs the underlying
server error to Vercel). Unknown URLs render the branded `app/not-found.tsx`
404.

## Correlating a user report to logs

1. Ask what they did, roughly when, and what they saw.
2. In Vercel **Logs**, filter by time and route (e.g.
   `/api/trade-inquiry`).
3. Search the relevant `event` name (table above), or the `requestId` /
   error `digest` the user or a screenshot captured.
4. For admin actions, also check the `adminAuditLogs` collection — audit
   records capture *successful* business operations; application logs
   capture *failures*.

## Intentionally not monitored yet

- Browser `console.error` detail stays in the user's browser — the Sentry
  browser SDK reports uncaught exceptions and boundary failures (sanitized)
  but not console output or breadcrumbs.
- Per-instance rate limits/cooldowns reset on cold start (see
  `docs/TECHNICAL.md` §16) and emit no metrics.
- Analytics-quality questions (event coverage, conversions) are Issue #24's
  scope, kept separate from operational observability.
