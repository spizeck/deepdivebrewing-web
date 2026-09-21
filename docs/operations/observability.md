# Observability & Error Handling

How production failures surface, what gets logged, and how to correlate a
user-reported problem with server logs. The app uses **Vercel runtime logs**
for detail and **Sentry** (server-side only, Issue #85) for proactive error
alerting — plus existing analytics for product questions.

## Where the signals live

| Signal | Where | Purpose |
| --- | --- | --- |
| Error monitoring | Sentry project (`deepdivebrewing-web`) | Proactive alerting + grouping for actionable server failures |
| Server logs | Vercel dashboard → project → **Logs** (runtime) | API-route and render failures, operational events, full error detail |
| Build logs | Vercel deployment → **Build Logs** | Prerender/static-generation failures |
| Admin audit logs | Firestore `adminAuditLogs` collection | Who did which admin action (business audit, not error tracking) |
| GA4 / Vercel Analytics / Speed Insights | respective dashboards | Product and traffic questions only — **not** error monitoring |
| Browser smoke tests | CI `Verify` job | Catch unhandled page errors, console errors, and 5xx/4xx responses on every PR before deploy |

## Error monitoring (Sentry)

Server-side capture via `@sentry/nextjs`, wired in `lib/monitoring.ts` and
`instrumentation.ts`. Chosen over Vercel-only monitoring (Vercel has no
built-in error-alerting path without paid log drains to an external
provider) and over custom email/webhook alerting (which would reinvent
grouping/dedup and risk alert storms). The client SDK is deliberately
**not** installed: the failures that matter are server-side, uncaught render
errors are already captured by `onRequestError` server-side, and a browser
SDK would add bundle weight, CSP surface, and a privacy surface for little
signal. Revisit only if client-side failures prove meaningful.

### What is reported

Every `logError` call reports its event — the funnel in `lib/log.ts` covers
all current and future call sites, so the reported set is exactly the
actionable failure events in the table above (persistence failures, email
send failures, unexpected route errors, misconfigurations, claims-sync
rollbacks). `instrumentation.ts` `onRequestError` additionally reports
uncaught server render/route errors that bypass `logError`
(`next.request_error`).

### What is never reported

- `logInfo`/`logWarn` events — routine denials (`admin_auth.denied`),
  expected conditions, and audit noise stay in Vercel logs only.
- Validation failures, honeypot hits, rate limits, 401/403/404s — those
  paths never call `logError`; Next.js also filters `notFound()`/`redirect()`
  control flow out of `onRequestError`.
- PII and secrets: `sendDefaultPii: false`, and `scrubEvent` (`beforeSend`)
  removes request headers, cookies, bodies, user context, and query strings.
  Log context is already key-filtered in `lib/log.ts` before it is ever
  forwarded. No tracing (`tracesSampleRate: 0`), no breadcrumbs, no session
  replay.
- **Raw exceptions**: provider/runtime error objects are uncontrolled text —
  they can embed emails, tokens, URLs with credentials, or customer values.
  `sanitizeError` sends a reduced synthetic `Error` instead: name, code,
  a message with emails/tokens/URL-queries/long-opaque-strings redacted and
  capped at 300 chars, and a rebuilt stack whose frames (paths, function
  names, line:column — never runtime values) are individually scrubbed. The
  full original error still lands in Vercel logs per the logging policy.

### Issue grouping

Curated `logError` events fingerprint as `["deepdivebrewing", <event>]` —
every occurrence of a failure class groups into one issue, so a "new issue"
alert fires once per failure mode. `next.request_error` gets **no custom
fingerprint**: uncaught exceptions group by Sentry's normal rules (type +
sanitized stack), keeping distinct failures distinct while the `event` tag
remains available for filtering.

### Environment behavior

Reporting is enabled only when **both** `VERCEL_ENV=production` (set by
Vercel automatically) **and** `SENTRY_DSN` are present. Preview, dev, CI, and
credential-free builds can never emit events — `next build` needs nothing.
Every event retains the stable `event` tag for filtering; how issues group
follows the fingerprint policy in "Issue grouping" above.

### Alert setup (required post-deployment step)

Alert routing lives in Sentry, not the repo — no notification destination is
hard-coded. After creating the project and setting `SENTRY_DSN` in Vercel
(Production scope):

1. Sentry → project **Settings → Alerts → Alert Rules → New Alert Rule**.
2. Condition: **When a new issue is created** (event fingerprinting already
   dedupes repeats into one issue, so this fires once per failure class).
3. Action: notify the project team via email (or the owner's preferred
   destination — do not commit one to the repo).
4. Optionally add a second rule for issue **spikes** (same issue recurring
   >10×/hour) if a noisy failure mode emerges.

### Correlating a Sentry issue to Vercel logs

Each event carries `event` (the stable log event name) as a tag and the
sanitized log context (e.g. `requestId`, `leadId`) as extras. Search Vercel
**Logs** for the same `event`/`requestId` to see the full error including
stack and provider details.

### Testing the integration safely

- **Unit tests** (`tests/lib/monitoring.test.ts`) exercise the funnel,
  scrubbing, env gating, and failure isolation without a network.
- **End-to-end**: set `SENTRY_DSN` + `VERCEL_ENV=production` locally, run
  `npm run build && npm run start`, then trigger a real failure — e.g.
  temporarily unset `RESEND_API_KEY` and submit the trade form (the lead
  persists, notification fails, `trade_inquiry.notification_failed` appears
  in Sentry). Never point CI or preview deploys at the production project.
- **TEMPORARY verification endpoint** (remove after the production alert is
  confirmed): `POST /api/admin/monitoring/test` — admin-only (the standard
  `requireAdminActor` bearer-token check; anonymous calls get 401). It emits
  one `monitoring.test_error` `logError` whose synthetic `Error` carries fake
  sensitive values (a test email, bearer token, URL query, opaque token), so
  the resulting Sentry issue proves sanitization as well as delivery and
  alerting. It is a silent no-op outside production (the normal
  `VERCEL_ENV`/`NEXT_RUNTIME`/`SENTRY_DSN` gate still applies). To verify:
  sign in to `/admin`, copy your ID token, and POST with
  `Authorization: Bearer <token>`; expect `{ "ok": true }`, one
  `monitoring.test_error` line in Vercel logs, one new Sentry issue, and one
  alert. Then remove the route, `lib/monitoring-test.ts`, its test, and this
  note in a cleanup PR.

### If Sentry is unavailable or misconfigured

Nothing changes for users: reporting is fire-and-forget, every failure path
is wrapped, and the flush is bounded at 2s. If `SENTRY_DSN` is unset or
wrong, capture is a silent no-op. Vercel logs keep the full structured
record regardless — monitoring is a notification layer, never a dependency.

### Disabling / rolling back

Remove `SENTRY_DSN` from Vercel (Production) and redeploy — reporting stops
immediately with no code change. To remove the integration entirely, revert
the PR that introduced `lib/monitoring.ts`/`instrumentation.ts` and uninstall
`@sentry/nextjs`.

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

- No client-side error reporting pipeline — browser `console.error` output
  (including the error boundary's digest line) stays in the user's browser.
  Uncaught *server* render errors are reported via `onRequestError`; pure
  client-side failures are not (see "Error monitoring" for the rationale).
- Per-instance rate limits/cooldowns reset on cold start (see
  `docs/TECHNICAL.md` §16) and emit no metrics.
- Analytics-quality questions (event coverage, conversions) are Issue #24's
  scope, kept separate from operational observability.
