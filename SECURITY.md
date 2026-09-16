# Security Policy

This repository is the actively maintained production website and
content-management application for Deep Dive Brewing Co., live at
<https://deepdivebrewing.com>. This policy describes the current
implementation; the code is the final source of truth, and
[docs/TECHNICAL.md](docs/TECHNICAL.md) is the detailed architecture
reference.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do not open a public GitHub issue, pull request, or discussion for a
suspected vulnerability.** This is a public repository; a public report
discloses the issue before it can be fixed.

Instead, email **info@deepdivebrewing.com**.

A useful report includes:

- A description of the vulnerability and its potential impact.
- The affected area — a URL, route, or component (for example
  `/api/admin/*`, `firestore.rules`, `storage.rules`, or the trade-inquiry
  form).
- Steps to reproduce, including the access level used (anonymous,
  signed-in non-admin, admin, superadmin).
- Relevant request/response details, console output, or error messages —
  with any credentials, tokens, or private keys **redacted**.
- Whether you were able to read or modify data you should not have been
  able to.

Never include real secret values in a report.

### What to expect

- We will acknowledge receipt and investigate the report.
- We may follow up for clarification or reproduction details.
- We will deploy a fix to production once confirmed and validated.
- Please allow a reasonable window for investigation and remediation
  before any public disclosure.

## Scope

This policy covers:

- The Next.js application, including its API routes under `app/api/`.
- Firebase Authentication, Firestore, and Storage security configuration.
- The admin access model: custom claims, `adminUsers`, invitations, and
  audit logs.
- Environment-variable and secret handling in local development, CI, and
  Vercel.
- Third-party dependency vulnerabilities that affect this application.

## Security architecture summary

- **Authentication:** Firebase Authentication, Google sign-in only.
  Signing in proves identity; by itself it grants no access.
- **Authorization:** custom claims on the Firebase ID token —
  `{ admin: true, role: "admin" | "superadmin" }` — plus a matching
  `adminUsers` record for the acting user that exists, has
  `status === "active"`, and carries the same role as the claims. Every
  privileged API route enforces this per request via
  `requireAdminActor`/`requireSuperAdminActor` in `lib/admin-auth.ts`.
  Role agreement is required because embedded token claims lag server-side
  role changes until the token is refreshed — a demoted admin holding a
  stale token must not keep elevated access. Two lifecycle routes are
  deliberate exceptions: `/api/admin/bootstrap` (creates the first
  superadmin, gated by `SUPER_ADMIN_EMAIL`) and
  `/api/admin/invitations/accept` (creates the record on acceptance, gated
  by a pending invitation and verified email).
- **Roles:** `admin` manages content and can trigger rebuilds;
  `superadmin` additionally manages administrators and invitations.
  Policy guards prevent demoting, disabling, or revoking the last active
  superadmin and the protected `SUPER_ADMIN_EMAIL` bootstrap account.
- **Invitations:** `adminInvitations` records track
  pending/accepted/cancelled state. Superadmins create invitations through
  `/api/admin/users`; the invite email is sent via Resend; acceptance at
  `/api/admin/invitations/accept` creates the `adminUsers` record and sets
  custom claims transactionally, with rollback on partial failure.
- **Audit trail:** administrative actions are appended to
  `adminAuditLogs`. Rules allow superadmin create/read but deny all client
  updates and deletes, so the trail is immutable to clients.
- **Admin SDK boundary:** `lib/firebase-admin.ts` and the server-side
  `lib/admin-*.ts` modules are `server-only`. The Admin SDK bypasses
  Firestore and Storage security rules, so it must never run in client
  code or be initialized from client-visible configuration.
- **Client SDK boundary:** public reads of `isPublic` beer/venue
  documents, plus the admin dashboard's content writes (beers, venues,
  `meta/siteRebuild`, Storage uploads), are authorized by
  `firestore.rules` and `storage.rules`. The rules enforce the same
  invariant as the API routes: valid claims **plus** an existing, active
  `adminUsers` record whose role matches the claims — so a stale token
  cannot keep writing after an admin is disabled or demoted. Storage
  rules do this through a cross-service `firestore.get()` lookup against
  the `(default)` database. A catch-all rule denies everything else.
- **Protected admin APIs:** every privileged `/api/admin/*` operation
  requires a verified ID token, valid claims, and an active `adminUsers`
  record for the acting user; administrator-mutation routes (`users`,
  `users/[uid]`, `invitations/[id]/resend`) additionally require the
  `superadmin` role. (`/api/admin/me` also exposes a non-privileged probe
  path that reports bootstrap eligibility or a pending invitation to
  signed-in users without claims.)
- **Rebuild authorization:** `POST /api/admin/rebuild` requires the same
  token + claims + active-record check before calling the Vercel deploy
  hook. The hook URL is a server-only secret, and a per-instance cooldown
  (`ADMIN_REBUILD_COOLDOWN_MS`) limits trigger frequency.
- **Security headers:** `next.config.ts` sets a Content-Security-Policy,
  `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`,
  `Permissions-Policy`, and HSTS, and enforces HTTPS + apex-domain 308
  redirects.
- **UI is not authorization:** the dashboard hides controls a user cannot
  use, but that is convenience only — enforcement lives in the API routes
  and the Firebase security rules.

See `docs/TECHNICAL.md` §6–§8 and §15 for the full description.

## Public vs. secret configuration

### Public client configuration (`NEXT_PUBLIC_*`)

These values are embedded in the client bundle and are intentionally
visible to browsers. They identify the Firebase and analytics projects;
**they are not authorization secrets** and do not need rotation merely
because they are publicly visible:

- `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`,
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID`,
  `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`,
  `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`,
  `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID`
- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_GA_ID`

### Server-only secrets

True secrets and capability URLs. Disclosure of any of these warrants
rotation — see
[docs/operations/credential-rotation.md](docs/operations/credential-rotation.md):

- `FIREBASE_ADMIN_PRIVATE_KEY` — service-account private key (PEM; stored
  with `\n` escapes). Grants full Firebase Admin access.
- `RESEND_API_KEY` — Resend API key. Authorizes sending email. Supplied by
  the Vercel-managed Resend integration in deployed environments.
- `VERCEL_DEPLOY_HOOK_URL` — capability URL: anyone holding it can trigger
  a production deploy.
- `VERCEL_REBUILD_DEPLOY_HOOK_URL` — legacy fallback deploy-hook variable,
  still supported by the rebuild route; treat identically.

### Server-only configuration (sensitive, not credentials)

Not cryptographic secrets, but they must stay out of the client bundle,
documentation, tests, and logs:

- `FIREBASE_ADMIN_PROJECT_ID` — Admin SDK project id (falls back to
  `NEXT_PUBLIC_FIREBASE_PROJECT_ID`).
- `FIREBASE_ADMIN_CLIENT_EMAIL` — service-account email paired with the
  private key.
- `SUPER_ADMIN_EMAIL` — the only account `/api/admin/bootstrap` will
  promote and the email protected from demotion/disable/revocation.
- `TRADE_INQUIRY_TO_EMAIL` — trade-inquiry recipient inbox.
- `RESEND_FROM_EMAIL` — shared default sender (trade emails; fallback for
  invitations). Optional — senders resolve to `noreply@mail.deepdivebrewing.com`
  when unset.
- `ADMIN_INVITE_FROM_EMAIL` — preferred invitation sender.
- `ADMIN_REBUILD_COOLDOWN_MS` — rebuild cooldown (default `600000`).
- `ADMIN_INVITE_RESEND_COOLDOWN_MS` — invitation resend cooldown (default
  `60000`).

Names and roles are also listed in `.env.local.example` (names only) and
`docs/TECHNICAL.md` §13. Values are never committed.

## Logging and sensitive data

Never log:

- API keys (`RESEND_API_KEY` or any provider key).
- Firebase Admin credentials, especially `FIREBASE_ADMIN_PRIVATE_KEY`.
- Firebase ID tokens, session tokens, or `Authorization` header values.
- Deploy-hook URLs (`VERCEL_DEPLOY_HOOK_URL`,
  `VERCEL_REBUILD_DEPLOY_HOOK_URL`).
- Raw environment dumps (`process.env`, `env`, `printenv`, `.env.local`
  contents).
- Customer or private data beyond what an operation genuinely needs
  (trade-inquiry contents, admin email addresses in unrelated logging).

Accidental-disclosure surfaces to watch: build caches (`.next/`,
Turbopack/webpack caches), terminal output and scrollback, CI logs,
screenshots and screen recordings, and AI/agent transcripts. If a secret
reaches any of these, follow the incident checklist in
[docs/operations/credential-rotation.md](docs/operations/credential-rotation.md#f-accidental-disclosure-response).

## Local development security

- `.env.local` must remain gitignored. `.gitignore` covers `.env*` and
  service-account JSON files; only `.env.local.example` (names and
  placeholders) is committed.
- Restore a lost or stale `.env.local` from authoritative sources —
  `vercel env pull` / the Vercel dashboard, the Firebase console, and the
  Resend dashboard — per
  [docs/operations/credential-rotation.md](docs/operations/credential-rotation.md#e-local-envlocal-restore).
- Do not treat `.next/` caches, shell history, or tool output as secret
  stores; values recovered from them may be stale and should be treated as
  potentially exposed.
- Never paste production credentials into committed example files, tests,
  or fixtures.

## CI security posture

- CI (`.github/workflows/ci.yml`) is intentionally **secret-free**: it
  runs typecheck, lint, tests, build, and the Markdown-link check with
  `permissions: contents: read` and no secrets.
- No environment variables are injected anywhere in CI. Service clients
  initialize lazily (`getResendClient()` in `lib/resend.ts`,
  `getFirebase*()` getters in `lib/firebase.ts`), so `next build` evaluates
  no service clients; Firestore reads during static generation resolve
  empty when no project config is present. Do not add real Firebase Admin,
  Resend, or Vercel secrets to CI merely to make it pass.

## Firebase security boundaries

- The public `NEXT_PUBLIC_FIREBASE_*` client config only identifies the
  project. Possessing it grants nothing; `firestore.rules` and
  `storage.rules` are the authorization boundary for all client SDK
  traffic.
- The Admin SDK bypasses security rules entirely, so its credentials and
  every module that uses them must remain server-only.
- Admin access requires both valid custom claims and an existing, active
  `adminUsers` record whose role matches the claims; either alone is
  insufficient — on the protected API routes (`lib/admin-auth.ts`) and in
  the Firestore/Storage security rules alike. Each privileged request
  reads the acting user's `adminUsers` document once (repeated lookups to
  the same document are cached within a single rules evaluation).
- UI visibility (hidden buttons/tabs) is never an authorization boundary.

## Dependency and vulnerability maintenance

- CI gates every pull request to `main`: `tsc --noEmit`, ESLint, the
  `node:test` suite, Firebase emulator rules tests, a production build, the
  Markdown-link check, and a check that `react`/`react-dom` declare the same
  version (`npm run check:react-versions`).
- Dependabot (`.github/dependabot.yml`) opens weekly npm and GitHub Actions
  update PRs on Mondays, labeled `type: dependencies`. Routine minor/patch
  tooling updates are grouped; production runtime packages and all major
  updates arrive individually for manual review. React and ReactDOM
  minor/patch updates are grouped when both have releases available — the CI
  version check, not Dependabot, enforces that their declared versions stay
  aligned. Auto-merge is not enabled — every update passes the same required
  CI as any other PR.
- Dependabot **security** updates are a separate GitHub mechanism and may
  open PRs outside the weekly cadence; they are not disabled.
- `npm audit` findings are triaged routinely; not every advisory is fixable
  by Dependabot (transitive/dev-only chains may need targeted work).

## Credential rotation and secret recovery

Step-by-step procedures for rotating Resend, Firebase Admin, Vercel
deploy-hook, and bootstrap configuration — plus `.env.local` recovery and
accidental-disclosure response — live in
[docs/operations/credential-rotation.md](docs/operations/credential-rotation.md).
