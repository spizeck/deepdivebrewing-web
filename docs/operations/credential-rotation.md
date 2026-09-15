# Credential Rotation Runbook

Operational procedures for rotating the credentials and sensitive
configuration used by the Deep Dive Brewing Co website. Read the
[rotation principles](#rotation-principles) before touching any Vercel
environment variable or Firebase credential.

**Scope:** rotating values only. Do not change `firestore.rules`,
`storage.rules`, custom claims, or `adminUsers` records as part of a
credential rotation unless a procedure below explicitly says so.

## Authoritative locations

| Value | Authoritative source |
| --- | --- |
| `RESEND_API_KEY` | Resend dashboard (or the Vercel-managed Resend integration, if the project uses it) |
| `RESEND_FROM_EMAIL`, `ADMIN_INVITE_FROM_EMAIL` | Verified sender domain in Resend + Vercel env vars |
| `FIREBASE_ADMIN_*` | Firebase console → Project settings → Service accounts (key pair lives in Google Cloud IAM) |
| `VERCEL_DEPLOY_HOOK_URL` | Vercel project → Settings → Git → Deploy Hooks |
| `SUPER_ADMIN_EMAIL`, cooldowns, `TRADE_INQUIRY_TO_EMAIL` | Vercel environment variables (no external issuer) |
| `NEXT_PUBLIC_*` | Firebase console → web app config; GA4 admin for `NEXT_PUBLIC_GA_ID` |

- **Vercel environment variables** (Project → Settings → Environment
  Variables) are the source of truth for what the deployed application
  uses. Note each variable's scope: Production, Preview, Development.
  Changing an env var does **not** affect already-deployed builds —
  always redeploy after updating.
- **Local `.env.local`** is a per-developer copy. It is gitignored; keep
  it in sync from the authoritative sources above (see
  [§E](#e-local-envlocal-restore)).

## Rotation principles

1. **Create the new credential before revoking the old one** wherever the
   provider allows overlap (Resend keys, service-account keys, deploy
   hooks all allow overlap).
2. **Rotate one credential family at a time.** Verify it end to end before
   starting the next.
3. **Deploy and verify before revocation.** The old credential stays
   valid until you delete it — use that window.
4. **Least privilege:** scope new keys to the minimum the app needs (e.g.
   a send-only Resend key if offered; a dedicated service account for this
   app).
5. **Do not rotate public config unnecessarily.** `NEXT_PUBLIC_*` values
   are public by design; visibility alone is not a reason to rotate them.
6. **Never paste secrets** into GitHub issues, PRs, docs, commit messages,
   or chat/agent transcripts.
7. **Record the rotation** (date, credential, reason) in your own
   operations notes. If the note itself contains sensitive material, keep
   it outside this repository — it is public.

---

## A. Resend — `RESEND_API_KEY` and sender configuration

**Consumers:** `app/api/trade-inquiry/route.ts` (trade inquiries) and
`lib/admin-invitation-email.ts` (admin invitations). Sender identity comes
from `RESEND_FROM_EMAIL` (trade; fallback for invitations) and
`ADMIN_INVITE_FROM_EMAIL` (invitations, preferred).

The project may use a standalone Resend account or the Vercel-managed
Resend integration — the steps are the same either way; only the console
location differs.

### Steps

1. Create a **new** API key in the Resend console (or the Vercel
   integration's Resend settings). Choose the least-privilege scope
   available (sending only — the app never reads via the API).
2. Update `RESEND_API_KEY` in the Vercel dashboard for every scope that
   sends email — at minimum **Production**; Preview/Development as needed.
   (Under the Vercel integration this may surface as a managed variable;
   update it there.)
3. Update `.env.local` on each development machine.
4. Redeploy production (push to `main`, or trigger a rebuild) so the new
   value reaches the serverless functions.
5. Verify (below), **then** revoke the old key in the Resend console.

### If sender configuration also changes

- Verify the new sending domain/address in Resend **before** pointing
  `RESEND_FROM_EMAIL` or `ADMIN_INVITE_FROM_EMAIL` at it — unverified
  senders fail at send time.
- Update the variables in Vercel and `.env.local`, redeploy, and verify
  both email flows.

### Verify

- Submit a real trade inquiry on a preview or production URL; confirm it
  arrives at the `TRADE_INQUIRY_TO_EMAIL` inbox.
- As a superadmin, create or resend a test invitation from `/admin` →
  **Access**; confirm the email arrives and the invitation's
  `emailStatus` becomes `sent` (visible in the dashboard/Firestore).
- Confirm the fresh deployment builds and reaches "Ready" in Vercel.
- Review Vercel function logs for `Resend` / email errors after the
  deployment.

### Revoke

Delete the old API key only after all verification passes. If the old key
was suspected of exposure, do not wait — revoke as soon as the new key is
verified live.

---

## B. Firebase Admin credentials (`FIREBASE_ADMIN_*`)

`FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`, and
`FIREBASE_ADMIN_PRIVATE_KEY` together form the service-account credential
the Admin SDK uses for every `/api/admin/*` route and the
`bootstrap-superadmin` script.

**Do not confuse these with `NEXT_PUBLIC_FIREBASE_*`.** The public
variables are the client web-app config; rotating the service account does
not change them, and vice versa.

### Steps

1. In the Firebase console → Project settings → **Service accounts**,
   generate a new private key for the service account. This downloads a
   JSON file containing `project_id`, `client_email`, and `private_key`.
   - Store the JSON in a password manager or secret store; do not commit
     it (the `.gitignore` patterns for `*firebase-adminsdk*.json` etc.
     exist as a backstop, not a storage location).
2. Update Vercel env vars (Production, and Preview/Development as needed):
   - `FIREBASE_ADMIN_PRIVATE_KEY` — the PEM, stored as a single line with
     literal `\n` escapes inside quotes (the code un-escapes it).
   - `FIREBASE_ADMIN_CLIENT_EMAIL` — the `client_email` from the JSON.
   - `FIREBASE_ADMIN_PROJECT_ID` — only if the project id changed
     (otherwise it may fall back to `NEXT_PUBLIC_FIREBASE_PROJECT_ID`).
3. Update `.env.local` on each development machine the same way.
4. Redeploy production.
5. Verify (below), then delete the old key: Firebase console → Service
   accounts → manage keys → delete the previous key id.

### Verify

- Sign in at `/admin` as an existing admin and confirm the dashboard
  loads — proves Admin SDK initialization and ID-token verification.
- `GET /api/admin/me` returns `isAdmin: true` with the expected `role`
  (the dashboard calls this; check the network tab or use `curl` with a
  Bearer token).
- As a superadmin: list admins/invitations (**Access** tab), and if
  practical run a full invite → accept round trip on a test account.
- Trigger a rebuild from `/admin` and confirm `/api/admin/rebuild`
  returns `ok: true` and a new Vercel deployment starts.
- Check Vercel function logs for `Missing Firebase Admin credentials` or
  `verifyIdToken` errors.
- Confirm CI still passes — CI must remain secret-free and does **not**
  need the new credential.

---

## C. Vercel deploy hook (`VERCEL_DEPLOY_HOOK_URL`)

The deploy-hook URL is a **capability URL**: anyone who has it can trigger
a production deploy. Treat it as a secret — never put it in client code,
docs, logs, or tickets.

`app/api/admin/rebuild` reads `VERCEL_DEPLOY_HOOK_URL` first and falls
back to `VERCEL_REBUILD_DEPLOY_HOOK_URL`. Rotate both if both are set.

### Steps

1. In Vercel → Project → Settings → Git → **Deploy Hooks**, create a new
   hook (name it, point it at the production branch — `main`).
2. Update `VERCEL_DEPLOY_HOOK_URL` in Vercel env vars for the scopes that
   use it (Production required; Preview/Development if they rebuild). If
   `VERCEL_REBUILD_DEPLOY_HOOK_URL` is still configured anywhere, update
   or remove it so it cannot silently select the old hook.
3. Update `.env.local` as needed for local testing.
4. Redeploy production.
5. Verify: trigger a rebuild from `/admin` and confirm a new deployment
   appears in Vercel.
6. Delete the old deploy hook in Vercel. Deleting the hook is the
   revocation step — the URL stays functional until then.

---

## D. `SUPER_ADMIN_EMAIL` and bootstrap configuration

`SUPER_ADMIN_EMAIL` is a server-only gate, not a credential. It controls:

- which verified Google account `/api/admin/bootstrap` will promote to
  superadmin,
- which email `isProtectedAdmin()` treats as protected — it cannot be
  invited again, and cannot be demoted, disabled, or revoked through the
  admin APIs.

**Important:** changing `SUPER_ADMIN_EMAIL` does **not** migrate
anything. It does not touch custom claims, `adminUsers` records, or
Firebase Auth users. It only changes which email future eligibility and
protection checks match.

### To change the bootstrap superadmin safely

1. Ensure the new account has signed in with Google at least once (so it
   exists in Firebase Authentication) and its email is verified.
2. Set `SUPER_ADMIN_EMAIL` to the new email in Vercel (Production +
   relevant scopes) and `.env.local`; redeploy.
3. Grant the new account superadmin — either:
   - sign in as that account at `/admin` and click **Complete Superadmin
     Setup** (calls `/api/admin/bootstrap`), or
   - run `npm run bootstrap-superadmin -- --dry-run`, then
     `npm run bootstrap-superadmin` locally with Admin credentials set.
4. Have the account sign out and back in; confirm `GET /api/admin/me`
   shows `role: "superadmin"` and the **Access** tab is available.
5. Decide what happens to the **old** bootstrap account. Its claims and
   `adminUsers` record are unchanged, and it has now lost its protected
   status — if it should no longer be superadmin, have a current
   superadmin demote or disable it via the **Access** tab. Always keep at
   least one active superadmin; policy prevents removing the last one.

---

## E. Local `.env.local` restore

If `.env.local` is lost, corrupted, or stale, rebuild it from
authoritative sources — **not** from caches:

1. Copy `.env.local.example` to `.env.local` for the complete variable
   list.
2. Pull values from authoritative stores:
   - `vercel link` + `vercel env pull .env.local` where the Vercel project
     is accessible (pulls the project's environment values), or
   - transcribe from the Vercel dashboard → Environment Variables,
   - Firebase console for `FIREBASE_ADMIN_*` / `NEXT_PUBLIC_FIREBASE_*`,
   - Resend console for `RESEND_API_KEY` and sender addresses.
3. Check parsing details:
   - `FIREBASE_ADMIN_PRIVATE_KEY` must stay a single quoted line with
     literal `\n` escapes — pasting a real multi-line PEM breaks dotenv
     parsing.
   - No stray quotes or trailing whitespace around values.
4. Verify the app: `npm run dev` starts, the site renders, Google sign-in
   at `/admin` works, and `GET /api/admin/me` responds (not a
  `Missing Firebase Admin credentials` error).
5. Confirm `git status` shows `.env.local` as untracked/ignored — never
   commit it, and never copy real production values into
   `.env.local.example`, tests, or fixtures.

**Do not recover secrets from `.next/`, Turbopack or other build caches,
shell history, terminal scrollback, or agent/tool logs except as an
emergency diagnostic.** Those copies may be stale or partial, they are not
authoritative secret stores, and a value that landed in them should be
treated as potentially exposed — restore from the authoritative source
and rotate the credential per the sections above.

---

## F. Accidental disclosure response

Use this checklist when a secret appears in terminal output, CI logs,
screenshots or screen recordings, chat/AI-agent output, local caches,
shell history, or committed files.

1. **Identify exactly which credential was exposed** and every surface it
   reached (one leak often spans several).
2. **Classify it.** Public `NEXT_PUBLIC_*` client config generally does
   not require rotation solely because it was visible — it is public by
   design. Actual secrets and capability URLs — `RESEND_API_KEY`,
   `FIREBASE_ADMIN_PRIVATE_KEY`, `FIREBASE_ADMIN_CLIENT_EMAIL`,
   `VERCEL_DEPLOY_HOOK_URL`/`VERCEL_REBUILD_DEPLOY_HOOK_URL` — should be
   rotated whenever disclosure risk is credible.
3. **Create the replacement** per sections A–C above.
4. **Update consumers** — Vercel env vars (all needed scopes),
   `.env.local` files, any other store holding the value.
5. **Redeploy and verify** the new credential per the matrix below.
6. **Revoke the old credential** — delete the Resend key, delete the
   service-account key, delete the deploy hook.
7. **Remove or redact the exposure** where possible: scrub CI/build logs,
   edit or delete messages and screenshots, remove the value from shell
   history and caches. If a secret was committed to git, assume it was
   copied — rotate it regardless of history rewriting.
8. **Inspect for misuse:**
   - Vercel deployment list for unexpected deployments (deploy hook).
   - Resend dashboard/logs for unexpected sends (`RESEND_API_KEY`).
   - `adminAuditLogs` and Firebase Auth users for unexpected admin
     activity (Admin SDK credentials).
9. **Write a brief incident note** — what was exposed, when, where, and
   what was rotated. Keep it outside the repository if it contains
   sensitive details.

---

## G. Rotation verification matrix

| Credential rotated | Must verify after redeploy |
| --- | --- |
| `RESEND_API_KEY` | Trade inquiry email arrives; invitation create/resend email arrives; `adminInvitations.emailStatus === "sent"`; no Resend errors in function logs |
| `RESEND_FROM_EMAIL` / `ADMIN_INVITE_FROM_EMAIL` | Both email flows deliver from the new sender; domain verified in Resend |
| `FIREBASE_ADMIN_*` | Admin sign-in; `/api/admin/me` returns role; superadmin lists users/invitations; invite + accept works; `/api/admin/rebuild` returns `ok`; no Admin SDK init errors in logs; CI still secret-free |
| `VERCEL_DEPLOY_HOOK_URL` (+ `VERCEL_REBUILD_DEPLOY_HOOK_URL`) | Admin rebuild triggers a new Vercel production deployment; old hook deleted |
| `SUPER_ADMIN_EMAIL` | New account bootstraps to superadmin; protected-account checks follow the new email; at least one active superadmin remains |
| `NEXT_PUBLIC_*` (only if values actually changed) | Google sign-in works; public pages render Firestore data; Storage images load; no CSP/`frame-src` errors for the Auth domain |

## Related documents

- [SECURITY.md](../../SECURITY.md) — reporting, public-vs-secret
  classification, boundary summary.
- [Deployment guide](./deployment.md) — env-var scopes, rebuild behavior.
- [Troubleshooting](./troubleshooting.md) — including the admin-lockout
  recovery path.
- [docs/TECHNICAL.md](../TECHNICAL.md) §13 — full variable reference.
