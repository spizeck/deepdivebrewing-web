# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project identity

This repository is the **production website and content-management application
for Deep Dive Brewing Co**, a real craft brewery on Saba, Dutch Caribbean. It is
live at <https://deepdivebrewing.com> with an admin dashboard at `/admin`.

This is not a demo, starter, or template. Changes ship to a real business. The
repository is public; business content, branding, and imagery are property of
Deep Dive Brews, BV.

## Technology

- **Next.js 16** (App Router, React Server Components, Turbopack) + **React 19**
- **TypeScript 5** (strict mode; `tsconfig.json` is the source of truth)
- **Tailwind CSS v4** + **shadcn/ui** (`components/ui`, Radix primitives)
- **Firebase** — Firestore, Storage, and Authentication (Google sign-in)
  via the client SDK; **firebase-admin** for server-only API routes
- **MDX** via `@next/mdx` for long-form pages
- **Resend** for transactional email (trade inquiries, admin invitations)
- **Vercel** hosting, Analytics, and Speed Insights; **GA4** via gtag
- **Node 24** required — `.nvmrc` is authoritative (`npm`, not pnpm/yarn).
  CI and Vercel production run Node 24 as well.
- **Tests:** Node's built-in `node:test` runner + `tsx` (`tests/**/*.test.ts`)
- **Lint:** ESLint 9 flat config (`eslint.config.mjs`, `eslint-config-next`)

## Repository layout

- `app/` — App Router routes. `app/(pages)/` holds the public site
  (`/`, `/beers`, `/beers/[slug]`, `/where-to-buy`, `/about`, `/contact`,
  `/privacy`, `/terms`, `/trade`, `/admin`) plus reserved `/trade/*`
  placeholders. Long-form content may be authored in MDX co-located as
  `page.mdx` (e.g., `/about`); every `(pages)` route has exactly one page
  file — never add a second `page.*` to a route folder, since which file
  wins is platform-dependent.
- `app/api/` — server routes: `admin/*` (bootstrap, me, users, invitations,
  rebuild) and `trade-inquiry`.
- `components/` — site and admin UI; `components/ui/` is shadcn primitives.
- `lib/` — **all** data access and domain logic: Firebase client
  (`firebase.ts`), server-only Admin SDK (`firebase-admin.ts`), data helpers
  (`beers.ts`, `venues.ts`, server-only `trade-leads.ts`), admin domain modules
  (`admin-*.ts`), analytics, types, utilities. Shared Firestore logic
  belongs here — the established exception is
  `components/admin-dashboard.tsx` (see Coding expectations).
- `content/` — reserved for future standalone content (currently unused).
- `docs/` — administrator handbook (`docs/admin/`) and operations guides
  (`docs/operations/`). Keep these authoritative.
- `scripts/` — seed scripts, asset tooling, and Playwright-based local
  diagnostic scripts (not part of CI).
- `smoke-tests/` — Playwright browser smoke tests run in CI against the
  production build.
- `tests/` — unit tests for admin domain logic plus assertions on
  `firestore.rules`/`storage.rules` content.
- `firestore.rules`, `storage.rules`, `firebase.json`, `.firebaserc` —
  Firebase security rules and project config (`deepdivebrewing-web`).
- `.github/workflows/ci.yml` — CI definition (see Verification).

## Source-of-truth rules

- **Code beats documentation.** When docs and implementation disagree, trust
  the code and report the discrepancy rather than propagating it.
- **Do not invent business or product content.** Beer/venue data, copy, and
  business rules come from the owner or existing implementation — never guess.
- **Brand/design rules** defer to `THEME_AND_BRANDING.md` and existing assets.
- **Security/auth rules** must be verified against `firestore.rules`,
  `storage.rules`, and `lib/admin-*.ts` before any modification.
- High-level docs: `README.md` (overview, setup, commands),
  `docs/TECHNICAL.md` (detailed architecture reference),
  `docs/` (admin + operations), `SECURITY.md` (vulnerability reporting).

## Coding expectations

- Make **focused, minimal changes** tied to the issue. No broad rewrites,
  drive-by refactors, unrelated dependency upgrades, or formatting churn.
- Preserve the established architecture unless the issue explicitly calls for
  architectural change.
- Do not introduce new frameworks, state-management libraries, alternative UI
  libraries, or overlapping dependencies without being asked.
- Follow existing TypeScript patterns: explicit types/interfaces for Firestore
  documents, strict mode, avoid `any`, prefer named exports, keep components
  small.
- Prefer Server Components and static rendering; keep public Firestore
  reads server-side. The only client-side Firestore write surface is
  `components/admin-dashboard.tsx`, which intentionally
  uses the authenticated client SDK (beer/venue saves, rebuild metadata,
  Storage uploads) gated by the active-admin security rules
  (`hasActiveAdmin`: claims plus an existing, active, role-matching
  `adminUsers` record). Do not migrate or "fix" that pattern unless an
  issue explicitly calls for it.
- Modules imported by client components must not transitively import
  `firebase/*` or `lib/firebase.ts` — that ships the Firebase client SDK to
  public routes. Pure helpers (e.g. `beerImageUrl` in `lib/utils.ts`) belong
  in Firebase-free modules; see `docs/operations/performance.md`.
- Avoid new abstractions unless they clearly pay for themselves.
- Keep changes accessible: prefer native HTML semantics over ARIA, every
  form control needs a programmatic label, never remove the global
  `:focus-visible` outline, dynamic status/error text uses
  `role="status"`/`role="alert"`, decorative imagery uses `alt=""`/
  `aria-hidden`, and honor `prefers-reduced-motion`. UI changes should pass
  `smoke-tests/accessibility.spec.ts` — see
  `docs/operations/accessibility.md`.
- **SEO/indexing:** every indexable page sets a unique title, description,
  self-referencing canonical, and its own `openGraph.url` (inheriting the
  root `og:url "/"` is a bug). Private/test/placeholder routes carry
  `noindex` metadata and a `robots.txt` `Disallow` — never rely on either
  as an access control. Canonical host is `https://deepdivebrewing.com`,
  resolved via `lib/site.ts` (`siteUrl`) — import it rather than re-reading
  `NEXT_PUBLIC_SITE_URL`. See `docs/operations/seo.md`;
  `smoke-tests/seo.spec.ts` guards this.

## Security boundaries

This is a public repository for a production site. Never:

- Commit `.env.local`, credentials, tokens, or private keys.
- Expose `FIREBASE_ADMIN_*` service-account credentials, `RESEND_API_KEY`,
  `VERCEL_DEPLOY_HOOK_URL`, `SUPER_ADMIN_EMAIL`, or other server-only values
  to client code, docs, tests, CI, or logs.
- Weaken authentication/authorization merely to make tests or CI pass.
- Bypass Firebase security rules or custom-claim checks.
- Log secrets or unnecessary customer/private data.

`NEXT_PUBLIC_*` Firebase client config is intentionally public — it only
identifies the project; access is enforced by `firestore.rules`,
`storage.rules`, and server-side claim verification. Everything without the
`NEXT_PUBLIC_` prefix is a secret.

## Admin and auth sensitivity

Admin access uses **Firebase Authentication (Google sign-in)** on the client
plus **server-enforced authorization**: API routes verify the Firebase ID
token with the Admin SDK and require custom claims
(`{ admin: true, role: "admin" | "superadmin" }`) **plus an existing, active
`adminUsers` record for the acting user whose role matches the claims** —
enforced centrally by `requireAdminActor`/`requireSuperAdminActor` in
`lib/admin-auth.ts` (`checkAdminActorRecord` in `lib/admin-policy.ts`), backed
by the `adminUsers`, `adminInvitations`, and `adminAuditLogs` Firestore
collections and matching security rules. Bootstrap is gated by the
server-only `SUPER_ADMIN_EMAIL`; `admin/bootstrap` and
`admin/invitations/accept` are documented lifecycle exceptions that create
the record.

The following are security-sensitive and require **tests** when changed:
custom-claim checks, superadmin/admin role boundaries, the invitation
lifecycle, audit logging, the rebuild endpoint, and any rules changes in
`firestore.rules`/`storage.rules`. The UI hiding admin controls is not an
authorization boundary — enforcement lives server-side.

## Environment and configuration

- Inspect `.env.local.example` and the initialization code (`lib/firebase.ts`,
  `lib/firebase-admin.ts`, API routes) before adding environment variables.
- Never put real secret values in documentation, tests, CI, or committed
  example files.
- CI (`.github/workflows/ci.yml`) uses no environment variables at all:
  service clients initialize lazily (`lib/resend.ts`,
  `lib/firebase.ts` getters), so `next build` evaluates no service clients.
  Keep CI secret-free; do not add dummy or real values to make it pass.

## Verification

Before considering work complete, run the same checks CI enforces on pull
requests and pushes to `main`:

```bash
npx tsc --noEmit        # TypeScript
npm run lint            # ESLint
npm test                # node:test suite
npm run test:rules      # Firestore/Storage emulator rules tests (needs Java)
npm run build           # production build (needs no env values)
npx playwright test     # browser smoke tests against the build (needs Chromium: npx playwright install chromium)
npm run check:md-links  # relative Markdown links
npm run check:react-versions  # react/react-dom declared versions must match
```

`npm ci` is appropriate when validating from a clean dependency state.

- Add or update **targeted tests** for changed behavior — required for
  security-sensitive admin/auth/rules changes.
- For UI changes, verify in a browser and capture screenshots where useful.
- Playwright scripts under `scripts/` are local/manual diagnostics that need
  a running site and sometimes real configuration; the deterministic
  credential-free smoke suite lives in `smoke-tests/` and runs in CI.

## Git and PR workflow

- Branch from current `main`; keep branches focused on one issue.
- Keep commits and PR scope tied to the issue; open PRs against `main`
  and fill in `.github/pull_request_template.md`. `CONTRIBUTING.md`
  documents the human-facing workflow; this file stays authoritative for
  agent work.
- Dependabot opens weekly dependency PRs (`.github/dependabot.yml`, label
  `type: dependencies`); they go through the same CI and review — do not
  auto-merge or batch them into feature work.
- Do not merge your own PR unless explicitly instructed.
- Report exact verification results and remaining concerns in the PR/final
  report.
- Do not silently fix unrelated defects found during scoped work — document
  them or propose follow-up issues instead.

## Documentation discipline

- Update docs when behavior, configuration, operations, or architecture
  changes.
- Do not duplicate detail across documents — link to the authoritative doc
  (`README.md`, `docs/`, `THEME_AND_BRANDING.md`, `SECURITY.md`) instead.
- Do not hardcode release or version numbers in general guidance.
