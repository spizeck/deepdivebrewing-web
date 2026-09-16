# Observability & Error Handling

How production failures surface, what gets logged, and how to correlate a
user-reported problem with server logs. This app intentionally uses **Vercel
runtime logs plus existing analytics** — no external error-monitoring product.

## Where the signals live

| Signal | Where | Purpose |
| --- | --- | --- |
| Server logs | Vercel dashboard → project → **Logs** (runtime) | API-route and render failures, operational events |
| Build logs | Vercel deployment → **Build Logs** | Prerender/static-generation failures |
| Admin audit logs | Firestore `adminAuditLogs` collection | Who did which admin action (business audit, not error tracking) |
| GA4 / Vercel Analytics / Speed Insights | respective dashboards | Product and traffic questions only — **not** error monitoring |
| Browser smoke tests | CI `Verify` job | Catch unhandled page errors, console errors, and 5xx/4xx responses on every PR before deploy |

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
| `trade_inquiry.misconfigured` | `RESEND_API_KEY` or `TRADE_INQUIRY_TO_EMAIL` unset (see `missing` field) |
| `trade_inquiry.send_failed` | Resend rejected the inquiry email |
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

- No external error tracking (Sentry etc.), alerting, or dashboards — Vercel
  logs must be checked manually when something is reported.
- No client-side error reporting pipeline — browser `console.error` output
  (including the error boundary's digest line) stays in the user's browser.
- Per-instance rate limits/cooldowns reset on cold start (see
  `docs/TECHNICAL.md` §16) and emit no metrics.
- Analytics-quality questions (event coverage, conversions) are Issue #24's
  scope, kept separate from operational observability.
