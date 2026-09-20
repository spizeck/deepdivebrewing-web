# Technical Architecture Reference

Current-state technical reference for the Deep Dive Brewing Co. production website.
This document describes what the code does today; the implementation is the source
of truth. For contributor-facing rules see [AGENTS.md](../AGENTS.md); for operational
runbooks see the documents under [`docs/`](./).

## 1. System overview

The repository contains the production website and content-management application
for Deep Dive Brewing Co., a craft brewery on Saba, Dutch Caribbean, hosted at
`https://deepdivebrewing.com`. It is a real business application, not a demo.

Major responsibilities:

- **Public brewery website** — home, about, contact, privacy, and terms pages,
  with per-page SEO metadata, canonical URLs, OpenGraph images, and JSON-LD
  structured data.
- **Beer catalog** — a browsable catalog (`/beers`) plus detail pages
  (`/beers/[slug]`) backed by the Firestore `beers` collection.
- **Where-to-buy / venue data** — `/where-to-buy` renders the Firestore `venues`
  collection, grouped by island, with venue image fallbacks.
- **Trade inquiry flow** — `/trade` hosts a wholesale inquiry form that posts to
  a server API route which emails the inquiry via Resend.
- **Admin / content management** — a client-side dashboard at `/admin` where
  authorized users edit beers, venues, and images directly through the
  authenticated Firebase client SDK, manage administrator access through
  protected API routes, and trigger production rebuilds.
- **Authentication & authorization** — Firebase Authentication (Google sign-in)
  plus custom claims (`admin`, `role: "admin" | "superadmin"`) backed by
  `adminUsers` records, enforced server-side by the Admin SDK and in
  Firestore/Storage security rules.
- **Analytics** — GA4 via `gtag`, Vercel Analytics, and Vercel Speed Insights,
  plus a small custom event layer for beer views, trade-form conversion, and
  outbound partner clicks.
- **Deployment / rebuild** — the site is statically prerendered on Vercel; an
  authorized "rebuild" action calls a Vercel deploy hook so admin content edits
  reach the live site.

High-level architecture: a Next.js App Router application serves mostly static
public pages whose content is read from Firestore at build time (client SDK),
while all privileged admin access flows either through security-rule-gated
client SDK writes (content management) or through Admin-SDK-backed API routes
(authentication state, invitations, access management, rebuild trigger).

## 2. Runtime and deployment model

- **Next.js 16, App Router** (`next.config.ts`, `pageExtensions` includes
  `ts`, `tsx`, `md`, `mdx`). React 19, TypeScript 5 strict mode. The build uses
  Turbopack (`next build` defaults to Turbopack in Next 16).
- **Server components by default.** Public pages (`app/page.tsx`,
  `beers`, `beers/[slug]`, `where-to-buy`, `about`, `contact`, `privacy`,
  `terms`, `trade`, `sitemap`) are async server components; the data-driven
  ones await Firestore reads during rendering.
- **Client components** are used where interactivity or browser state is
  required: `admin-dashboard.tsx`, `admin-access.tsx`, `trade-inquiry-form.tsx`,
  `beer-carousel.tsx`, `beers-filter-grid.tsx`, the analytics trackers,
  `mobile-menu.tsx`, `site-header-default.tsx`, and the home-page intro/CTA
  components.
- **Rendering model.** The production build output marks every page static
  (`○`) — including `/admin` and `/sitemap.xml` — except `/beers/[slug]` and
  all `/api/*` routes, which are dynamic (`ƒ`). Because there is no
  `generateStaticParams` for beer detail pages, each beer slug page is rendered
  on demand at request time.
- **Static generation reads live Firestore.** `getBeers()` / `getVenues()` use
  the Firebase *client* SDK, so `next build` performs real Firestore reads
  against the configured project during prerendering. If reads fail (denied,
  or no project configured at all — as in CI, which provides no env), the SDK
  logs errors, falls back to offline mode, and the pages still build with
  empty states — see `lib/beers.ts` and `lib/venues.ts` and the Firestore
  `INVALID_ARGUMENT`/`permission-denied` warnings observed in build logs.
- **Node runtime.** The repository is normalized on **Node 24** (active LTS):
  `.nvmrc` declares `24` and is the single source of truth — CI reads it via
  `actions/setup-node`'s `node-version-file`, `package.json` declares
  `engines.node: "24.x"` (also consumed by Vercel), and the Vercel project
  runs Node 24.x. Node 24 was chosen because it satisfies every dependency
  floor (`next` ≥ 20.9, `resend` ≥ 20, `firebase-admin` ≥ 18), matches the
  Vercel production runtime, and correctly expands the `node --test` glob —
  Node 20 silently matched zero test files. `npm` is the package manager.
- **Hosting.** Vercel, `deepdivebrewing.com` (and the `www` apex) in front of the
  Next.js app. `next.config.ts` also issues permanent 308 redirects
  (HTTP→HTTPS and `www.`→apex) based on `x-forwarded-proto`/host.
  `NEXT_PUBLIC_SITE_URL` defaults to `https://deepdivebrewing.com`
  in code, resolved once by `lib/site.ts` (`siteUrl`) — the single source of
  truth for canonical/OG/sitemap/robots/JSON-LD URLs. `firebase.json` configures Firestore/Storage rules files and
  `firestore.indexes.json` (currently empty) — Firebase hosts no frontend here;
  the Firebase project is used only for Auth, Firestore, and Storage.
- **Git → CI → production.** `main` is the production branch. GitHub Actions CI
  (`.github/workflows/ci.yml`) runs on every PR targeting `main` and every push
  to `main` (typecheck, lint, tests, build, Markdown-link check). Vercel
  production deploys are triggered by pushes to `main` and, additionally, by an
  explicit deploy-hook call from the admin dashboard. There is no deployment
  step in CI itself.
- **Rebuild/deploy-hook behavior.** `app/api/admin/rebuild/route.ts` accepts a
  Bearer ID token and resolves the actor via `requireAdminActor` — verified
  token, `admin: true` claim, and an existing `adminUsers` record with
  `status === "active"` whose role matches the claims — then applies a
  process-local in-memory cooldown (`ADMIN_REBUILD_COOLDOWN_MS`), and POSTs to
  `VERCEL_DEPLOY_HOOK_URL` (falling back to `VERCEL_REBUILD_DEPLOY_HOOK_URL`)
  with trigger email/role metadata. The cooldown only updates after a
  successful hook response, and — being in-memory — it is per serverless
  instance and does not survive cold starts. Separately, the dashboard writes
  content-change metadata to `meta/siteRebuild` via the client SDK (see §5 and
  §10).

## 3. Repository structure

| Path | Responsibility |
| --- | --- |
| `app/` | App Router routes. Root `layout.tsx` (header/footer shell, SEO defaults, favicon metadata pointing at `public/`, analytics wiring), `globals.css` (Tailwind v4 theme tokens), `robots.ts`, `sitemap.ts`, `page.tsx` (home). |
| `app/(pages)/` | Route group for all content pages — `about` (MDX), `admin`, `beers` (+`[slug]`), `contact`, `privacy`, `terms`, `trade` (+ `login`/`order`/`orders` "coming soon" placeholders), `where-to-buy` — sharing a `SiteHeaderDefault` layout. Pages are `.tsx`; `about` is authored as `page.mdx` — see §4. |
| `app/api/` | Server API routes: `admin/bootstrap`, `admin/invitations/accept`, `admin/invitations/[id]/resend`, `admin/me`, `admin/rebuild`, `admin/users` (GET list + POST create-invitation), `admin/users/[uid]` (PATCH/DELETE), and `trade-inquiry`. All are Admin-SDK-protected except `trade-inquiry`. |
| `components/` | App components: header/footer, home sections, cards, carousel/filter grid, analytics trackers, `admin-dashboard.tsx` (auth + data orchestration), `admin-workspace.tsx` (props-driven authenticated view shared with `/admin-fixture`), `admin-access.tsx`, `admin-fixture.tsx` (test-only data), `trade-inquiry-form.tsx`, `mdx-layout.tsx`. |
| `components/ui/` | shadcn/ui primitives (Radix-based) configured by `components.json`. |
| `lib/` | Shared logic. Client-safe: `firebase.ts`, `beers.ts`, `venues.ts`, `analytics.ts`, `types.ts`, `utils.ts`, `trade-leads-common.ts`, admin `*-common`/`admin-format.ts` helpers. Server-only (`import "server-only"`): `firebase-admin.ts`, `admin-auth.ts`, `admin-users.ts`, `admin-invitations.ts`, `admin-invitation-email.ts`, `admin-invitation-resend-core.ts`, `admin-audit.ts`, `trade-leads.ts`. Policy/serialization helpers shared by both: `admin-policy.ts`, `admin-serializers.ts`, `admin-invitation-policy.ts`, `admin-invitation-resend-policy.ts`, `admin-types.ts`. |
| `tests/` | Node `node:test` unit tests (`tsx` loader) for admin/auth/invitation/audit helpers and for the *contents* of `firestore.rules` and `storage.rules`. |
| `rules-tests/` | Emulator-backed security-rules tests (`@firebase/rules-unit-testing` against the Firestore/Storage emulators). Run via `npm run test:rules`, which wraps `firebase emulators:exec`; each file uses its own `demo-*` project so parallel `node:test` files stay isolated. |
| `scripts/` | Local/manual tooling: Playwright diagnostics (`*-check.mjs`, `hero-video-network.mjs`), `check-md-links.mjs`, `check-react-versions.mjs`, `optimize-assets.mjs`, `bootstrap-superadmin.ts`, `prune-trade-leads.ts`, `seed-beers.ts`, `seed-venues.ts`. `check-md-links.mjs` and `check-react-versions.mjs` run in CI; the Playwright diagnostics and prune script do not (CI browser coverage lives in `smoke-tests/`). |
| `docs/` | Admin handbook (`docs/admin/`), operations guides (`docs/operations/`: deployment, troubleshooting, post-deploy checklist), and this file. |
| `content/` | Legacy placeholder (`.gitkeep` only). MDX content is co-located under `app/(pages)/`; do not add files here expecting them to render. |
| `firestore.rules`, `storage.rules` | Firebase security rules — see §6/§15. |
| `firebase.json`, `.firebaserc`, `firestore.indexes.json` | Firebase project config (`deepdive-brewing` project), rules file mapping, and (empty) index config. |
| `.github/workflows/ci.yml` | CI — Node from `.nvmrc` (24), `npm ci`, typecheck, lint, unit tests, emulator rules tests (`test:rules`), build, Markdown-link check. |
| `.env.local.example` | Documented environment variable names (values are never committed). |

**Intentional exception:** `components/admin-dashboard.tsx` performs
authenticated *client* SDK writes (`setDoc` on `beers`, `venues`,
`meta/siteRebuild`, and `uploadBytes` to Storage). This is deliberate — it is
gated by the active-admin rules (`hasActiveAdmin`) in `firestore.rules` and
`storage.rules` — and is documented in `AGENTS.md`. Do not "clean it up" by
moving it into `lib/` or API routes without an explicit issue.

## 4. Routing and page model

| Route | File | Server/Client | Data dependencies | Purpose |
| --- | --- | --- | --- | --- |
| `/` | `app/page.tsx` | Server (static) | `beers` collection via `getBeers()` | Home page; hero, featured beer/carousel, intro, brewery/CTA sections. |
| `/beers` | `app/(pages)/beers/page.tsx` | Server (static) | `beers` via `getBeers()` | Catalog grid; `BeersFilterGrid` (client) provides filtering. |
| `/beers/[slug]` | `app/(pages)/beers/[slug]/page.tsx` | Server (**dynamic**, no `generateStaticParams`) | `beers` via `getBeerBySlug(slug)` | Beer detail; `generateMetadata` per slug, JSON-LD, `BeerViewTracker` (client) emits `beer_detail_view`; 404 via `notFound()`. |
| `/where-to-buy` | `app/(pages)/where-to-buy/page.tsx` | Server (static) | `venues` + `beers` | Venue list grouped by island (Saba, SXM, Statia normalization in `islandDisplayName`), `VenueCard` entries. |
| `/about` | `app/(pages)/about/page.mdx` | Server (static) | none | MDX content styled by `mdx-components.tsx`. |
| `/contact` | `app/(pages)/contact/page.tsx` | Server (static) | none | Contact details; `TrackedAnchor` for click analytics. |
| `/trade` | `app/(pages)/trade/page.tsx` | Server (static) | none | Wholesale/trade page hosting `TradeInquiryForm` (client). See the `/trade` note below. |
| `/trade/login`, `/trade/order`, `/trade/orders` | `app/(pages)/trade/*/page.tsx` | Server (static) | none | Reserved "Coming soon" placeholders for a future trade portal. `noindex,nofollow` + robots.txt `Disallow`. |
| `/privacy`, `/terms` | `app/(pages)/{privacy,terms}/page.tsx` | Server (static) | none | Legal text via `MdxLayout` + TSX content. |
| `/admin` | `app/(pages)/admin/page.tsx` | Server wrapper (`robots: noindex`) rendering the client `AdminDashboard` | Auth state, `beers`, `venues`, `meta/siteRebuild`, Storage | Admin dashboard. Auth checks happen client-side; real enforcement is in rules + APIs. |
| `/api/admin/*` | `app/api/admin/**` | Server (dynamic) | Admin SDK: Auth, Firestore | Bootstrap, `me`, users list/create-invitation, user patch/delete, invitation accept/resend, rebuild trigger. |
| `/api/trade-inquiry` | `app/api/trade-inquiry/route.ts` | Server (dynamic) | Resend | Validates the form payload and emails it; see §11. |
| `/sitemap.xml`, `/robots.txt` | `app/sitemap.ts`, `app/robots.ts` | Server (static — generated at build) | `beers` | SEO metadata routes; sitemap enumerates beer slugs at build time (empty without credentials — deterministic). robots.txt disallows `/admin`, `/admin-fixture`, `/trade/*` placeholders, and `/api/`; see `docs/operations/seo.md`. Favicons are static files in `public/` referenced from `app/layout.tsx` metadata. |

### The `/trade` route: single canonical `page.tsx`

`app/(pages)/trade/` previously contained **both** `page.tsx` and a tabled
`page.mdx` stub. Resolution of colliding page files proved
platform-dependent — Windows builds served `page.tsx` while Linux builds
(CI, Vercel) served the MDX stub — so the MDX file was removed in Issue
#46. `page.tsx` is the sole, canonical `/trade` implementation; the smoke
suite asserts TSX-only markers (the `Trade & Wholesale` h1 and the
"What to expect" section) so a regression is caught in CI.

No other route has a page-file collision: `about` has only `page.mdx`,
and every other `(pages)` route has only `page.tsx`. Do not add a second
`page.*` file to a route folder.

## 5. Data model and Firestore collections

All collections live in the `(default)` Firestore database of the
`deepdive-brewing` project. Field lists below come from `lib/types.ts` /
`lib/admin-types.ts` and the write paths; only fields actually written or read
in code are listed.

### `beers`

- **Purpose:** public beer catalog.
- **Key fields (`Beer` in `lib/types.ts`):** `name`, `slug`, `style`, `abv`,
  `ibu`/`srm` (nullable), `status` (`"core" | "seasonal" | "limited"`),
  `descriptionShort`, `tastingNotes[]`, `images` (`cardPath`, `heroPath`),
  `isPublic` (boolean), `sortOrder` (number). The dashboard's `setDoc` merge may
  also persist bookkeeping fields (e.g. `updatedAt`/`updatedBy`).
- **Reads:** public server components via client SDK (`lib/beers.ts`:
  `getBeers` — `where("isPublic","==",true)` + `orderBy("sortOrder")`;
  `getBeerBySlug` — `slug` + `isPublic` filters; `beerImageUrl`). Rules allow
  public reads only of `isPublic` docs; active admins (claim + active matching
  `adminUsers` record) can read all, which is how the dashboard lists
  non-public docs ordered by `sortOrder`.
- **Writes:** admin dashboard `setDoc(doc(db,"beers", slug), payload, {merge:true})`
  (client SDK) — requires `hasActiveAdmin` per `firestore.rules`.
- **Visibility:** public read of `isPublic` docs; admin read-all/write.

### `venues`

- **Purpose:** where-to-buy partner listings.
- **Key fields (`Venue` in `lib/types.ts`):** `name`, `slug`, `type`
  (`"bar_restaurant" | "retail"`), `locationName` (island/area string,
  normalized at render time), `carriesBeerSlugs[]`, optional
  `tapBeerSlugs[]`/`canBeerSlugs[]`, `isPublic`, `sortOrder`, `links`
  (`website`/`maps`/`instagram`/`facebook`/`untappd`), `notesPublic`.
- **Reads:** `/where-to-buy` via `getVenues()` (`isPublic` + `sortOrder`);
  rules allow public reads only of `isPublic` docs; admin dashboard reads all.
- **Writes:** admin dashboard `setDoc` merge keyed by `slug` (client SDK).
- **Visibility:** public read of `isPublic` docs; admin read-all/write.

### `tradeLeads`

- **Purpose:** durable store of wholesale inquiries submitted via `/trade`
  — the system of record (owner decision, #57); the Resend email is only a
  notification.
- **Fields:** `businessName`, `contactName`, `email`, `phoneOrWhatsapp`,
  `venueType`, `message`, `status` (`"new"` on create), `source`
  (`"trade_form"`), `createdAt`/`updatedAt` (server timestamps).
- **Writes:** server-only — `persistTradeLead()` in `lib/trade-leads.ts` via
  the Admin SDK from `POST /api/trade-inquiry`.
- **Visibility:** **no client access at all** — `read, write: if false`.
  Leads are PII; operators view them via the Firebase console (an admin UI
  would be a separate feature).
- **Retention (#59):** up to 24 months after the last meaningful activity —
  anchored on `updatedAt` (currently always equal to `createdAt` since
  nothing modifies leads) — unless a legitimate business/legal/accounting/
  dispute/security reason requires longer; earlier deletion when no longer
  needed. Pruning is manual via `npm run prune:trade-leads` (dry-run by
  default; `--delete` executes). No automated deletion exists.

### `adminUsers`

- **Purpose:** source of truth (with custom claims) for who is an administrator.
- **Key fields (per `admin-users-common.ts`/`AdminUserView`):** `email`
  (normalized), `role` (`"admin" | "superadmin"`), `status`
  (`"active" | "disabled"`), `createdAt`, `createdBy`, `updatedAt`,
  `updatedBy`, optional `displayName` and `lastLoginAt`, plus revocation
  fields when disabled.
- **Reads/writes:** in practice server-side only via Admin SDK
  (`lib/admin-users.ts` and `app/api/admin/users*`). Rules technically allow
  `hasActiveSuperAdmin()` client read/write, but no client code uses it.
- **Visibility:** private (superadmin-only by rules).

### `adminInvitations`

- **Purpose:** pending/accepted/cancelled invitation records for admin access.
- **Key fields (`AdminInvitation`/`AdminInvitationView`):** `email`
  (normalized), `role`, `status` (`"pending" | "accepted" | "cancelled"`),
  `invitedBy`, `createdAt`, `acceptedAt`, `acceptedBy`, and Resend
  delivery-tracking fields (`emailStatus`: `"pending" | "sent" | "failed"`,
  `lastEmailAttemptAt`, `messageId`).
- **Reads/writes:** in practice server-side only via Admin SDK
  (`lib/admin-invitations.ts`, `lib/admin-invitation-resend-core.ts`, and the
  invitation API routes). Rules allow `hasActiveSuperAdmin()` client read/write,
  but no client code uses it.
- **Visibility:** private (superadmin-only by rules).

### `adminAuditLogs`

- **Purpose:** append-only audit trail for administrative actions.
- **Key fields (`AdminAuditRecord` in `lib/admin-types.ts`):** `action` — a
  fixed union: `bootstrap`, `accept_invitation`, `create_invitation`,
  `resend_invitation`, `cancel_invitation`, `update_admin`, `revoke_admin`,
  `refresh_claims`; plus `targetUid`/`targetEmail`, `oldRole`/`newRole`,
  `oldStatus`/`newStatus`, `actingUid`/`actingEmail`, `metadata`, `timestamp`.
  Records are sanitized via `dropUndefinedValues` before write.
- **Writes:** server-only via `lib/admin-audit.ts` (`logAdminAudit`,
  best-effort — failures are logged, not thrown). Rules allow superadmin
  `create`/`read` but explicitly `update, delete: if false` — audit logs are
  immutable even to clients.
- **Visibility:** private (superadmin read by rules).

### `meta/siteRebuild` (collection `meta`)

- **Purpose:** content-change vs. rebuild bookkeeping for the dashboard banner.
- **Key fields:** `contentUpdatedAt`, `contentUpdatedBy`, `lastTriggeredAt`,
  `lastTriggeredBy`, `cooldownUntil` (number).
- **Reads/writes:** client SDK (`getDoc`/`setDoc` merge) in
  `admin-dashboard.tsx` — admin-gated by rules. Note the *route-level*
  rebuild cooldown in `app/api/admin/rebuild` is a separate in-memory value;
  `meta/siteRebuild.cooldownUntil` is dashboard bookkeeping, not server
  enforcement.
- **Visibility:** admin-only (rules deny public access).

### Firebase Authentication

Not a Firestore collection, but part of the data model: each admin is an Auth
user with custom claims `{ admin: true, role: "admin" | "superadmin" }` set by
the Admin SDK. Claims and the `adminUsers` record are kept in sync by the
API routes (with rollback on partial failure — see §7/§8).

## 6. Firebase architecture

- **Client SDK** (`lib/firebase.ts`): **lazily initialized** — importing the
  module reads no config and constructs nothing; `getFirebaseApp()` /
  `getFirebaseDb()` / `getFirebaseAuth()` / `getFirebaseStorage()` build and
  cache the app + services from `NEXT_PUBLIC_FIREBASE_*` config on first use,
  so `next build` page-data collection never requires Firebase values. Used by:
  - public server components for build-time reads (`beers`, `venues`),
  - the admin dashboard for reads *and writes* (beers/venues/meta, Storage
    uploads), all gated by rules,
  - Google sign-in (`GoogleAuthProvider` + `signInWithPopup`) in the dashboard.
- **Admin SDK** (`lib/firebase-admin.ts`, `import "server-only"`): initialized
  lazily from `FIREBASE_ADMIN_*` credentials; exports admin `auth`/`db`. Used by
  every protected API route and the server-only `lib/admin-*.ts` modules for
  ID-token verification, custom-claim assignment, and privileged Firestore
  access that bypasses security rules.
- **Firestore:** `beers`/`venues` are publicly readable only where
  `isPublic == true` and admin-writable; `meta` is admin-only; `adminUsers`,
  `adminInvitations`, and `adminAuditLogs` are superadmin-only in rules
  (audit logs additionally immutable — `update, delete: if false`); in practice
  only Admin SDK server code touches admin collections; `tradeLeads` denies
  all client access — leads are written server-side only. A catch-all rule
  denies everything else.
- **Storage:** `storage.rules` allows public reads and active-admin writes
  (`hasActiveAdmin`); images are stored under the `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
  and referenced by path fields (`images.heroPath`, `imagePath`) resolved
  through `beerImageUrl`/the public download URL pattern.
- **Authentication:** Google sign-in only. Admin status is **not** the Auth
  account itself — it is the combination of (a) custom claims on the ID token
  and (b) a matching, active `adminUsers` document for the acting user,
  enforced per request on every privileged route and client-rules path
  (see §7).
- **Security rules** (`firestore.rules`, `storage.rules`): `hasAdminClaim()`
  checks `request.auth.token.admin == true`; `hasSuperAdminClaim()` adds
  `role == 'superadmin'`; `isPublicDoc()` gates public reads of
  `beers`/`venues`. `hasActiveAdminRecord()` then loads
  `adminUsers/{request.auth.uid}` via `get()` and requires
  `status == 'active'` and `role == request.auth.token.role`, composing into
  `hasActiveAdmin()`/`hasActiveSuperAdmin()` — so the rules enforce the same
  stale-claim invariant as the API routes. Storage does the equivalent with a
  cross-service `firestore.get()` against the `(default)` database (deploying
  it requires granting the Storage service account Firestore read access —
  the CLI/console prompts on first deploy). Rules are the enforcement
  boundary for client SDK traffic; API routes enforce separately via Admin
  SDK verification in `lib/admin-auth.ts`.
- **Client vs. server boundary:** anything a browser can do directly is
  limited to public reads, admin content writes, and auth. Anything sensitive
  (claim changes, invitations, user listing/disablement, rebuild) goes through
  `/api/admin/*` where the Admin SDK verifies the Bearer token and re-checks
  role/status server-side.

## 7. Authentication and authorization

The real admin security flow:

1. **Sign-in:** the dashboard calls `signInWithPopup` with
   `GoogleAuthProvider` (Firebase Auth). Any Google account can *authenticate*;
   authentication alone grants nothing.
2. **ID token:** for API calls the client sends `Authorization: Bearer <idToken>`
   (`getIdToken()`); the dashboard also reads claims from the token to decide
   what to render.
3. **Custom claims:** `lib/admin-auth.ts` verifies the token and requires
   `admin === true` and `role` of `"admin"` or `"superadmin"`. Role gates:
   `admin` may use the dashboard content tools and rebuild; `superadmin` may
   additionally manage administrators and invitations.
4. **`adminUsers` record:** every privileged route resolves the acting user
   through `requireAdminActor`/`requireSuperAdminActor` (`lib/admin-auth.ts`),
   which require the record to exist, have `status === "active"`, and carry
   the same role as the claims (`checkAdminActorRecord` in
   `lib/admin-policy.ts`). Role agreement closes the stale-token window after
   a demotion: embedded claims lag `setCustomUserClaims` until refresh, so a
   demoted superadmin holding an old superadmin token is denied. A missing
   record is denied outright. Two documented lifecycle exceptions:
   `bootstrap` (creates the first superadmin; gated by `SUPER_ADMIN_EMAIL`)
   and `invitations/accept` (creates the record on acceptance; gated by a
   pending invitation + verified email, and still rejects an existing
   disabled record).
5. **Bootstrap:** `POST /api/admin/bootstrap` with a signed-in user whose email
   equals `SUPER_ADMIN_EMAIL` creates/reconciles the first `superadmin` record
   and sets claims. It attempts to roll back the claim change if Firestore
   reconciliation fails.
6. **Server-side enforcement:** every `/api/admin/*` route repeats the
   verify-claims-and-record check; `admin-policy.ts` encodes additional rules
   (e.g. only superadmins mutate admins; the last active superadmin cannot be
   demoted/disabled).
7. **Rules enforcement:** client SDK writes from the dashboard are authorized
   by `hasActiveAdmin`/`hasActiveSuperAdmin` in `firestore.rules` (and the
   cross-service equivalent in `storage.rules`), which require the claim
   **and** an existing, active, role-matching `adminUsers` record for the
   acting user. Each privileged request performs one cached `adminUsers`
   document lookup; batched writes stay well under the per-request access-call
   limits (10 single-doc / 20 batched in Firestore, 2 cross-service in
   Storage).
8. **UI is not a boundary:** the dashboard hides controls based on claims, but
   that is convenience only — an attacker replaying API calls or SDK writes is
   stopped by the server/rules layers, which is why both exist.

## 8. Admin invitation lifecycle

Implemented across `lib/admin-invitations.ts`, `lib/admin-invitation-email.ts`,
`lib/admin-invitation-resend-core.ts`, `lib/admin-invitation-resend-policy.ts`,
and `app/api/admin/invitations/**`. All operations are superadmin-only and
server-side.

1. **Creation** — `POST /api/admin/users` (superadmin; `GET` on the same route
   lists users + invitations). Validates/normalizes the email, rejects the
   protected `SUPER_ADMIN_EMAIL`, existing active `adminUsers`, existing
   pending invitations, and role conflicts. Creates a pending
   `adminInvitations` doc, then sends the invite email.
2. **Email delivery** — `sendAdminInvitationEmail` (in
   `lib/admin-invitation-email.ts`) sends via `getResendClient()`
   (`lib/resend.ts`, `import "server-only"`), which lazily constructs and
   caches the Resend client on first use. It returns a structured failure if
   `RESEND_API_KEY` is unset rather than throwing. It builds the invite link from `NEXT_PUBLIC_SITE_URL`, sends from
   `ADMIN_INVITE_FROM_EMAIL` (falling back to `RESEND_FROM_EMAIL`, then the
   shared default sender — see §13), then
   persists delivery state (`emailStatus`, `lastEmailAttemptAt`, `messageId`)
   back onto the invitation doc.
3. **Failure / partial success** — if Resend send fails, the pending invitation
   is retained with failure metadata and an error is returned. If the send
   succeeds but persisting status fails, the route returns a partial-success
   warning rather than failing the whole operation.
4. **Acceptance** — `POST /api/admin/invitations/accept`. Requires a signed-in,
   verified-email user. Finds the pending invitation by normalized email;
   rejects protected email, disabled `adminUsers`, missing/expired invitations,
   or role conflicts. A Firestore transaction creates the `adminUsers` doc and
   marks the invitation `accepted`; then custom claims are set via Admin SDK.
   If claim assignment fails, the code attempts to roll back the user record
   and invitation status. An audit event is logged on success.
5. **Resend** — `POST /api/admin/invitations/[id]/resend`. Enforces a cooldown
   (`ADMIN_INVITE_RESEND_COOLDOWN_MS`, default 60 s) against
   `lastEmailAttemptAt`; the resend attempt is *claimed inside a Firestore
   transaction* before calling Resend, so concurrent requests cannot both
   bypass the cooldown. Delivery status is persisted as above.
6. **Cancellation** — `cancelled` status exists in the model and a
   `cancel_invitation` audit action is recorded by the users/invitations
   endpoints.
7. **Audit logging** — `logAdminAudit` records bootstrap, invitation
   create/resend/accept/cancel, admin update/revoke, and claims-refresh events.
   Audit writes are best-effort: a logging failure is captured
   (`console.error`) but does not convert an otherwise-successful operation
   into a failure.

## 9. Public data flows

- **Beer catalog:** `getBeers()` (client SDK) queries `beers` where
  `isPublic == true`, ordered by `sortOrder`; `getBeerBySlug(slug)` additionally
  filters by `slug` — non-public beers 404 on the detail route.
  `beerImageUrl(path)` resolves Storage paths to public URLs. `/beers` renders
  the grid; `/` surfaces beers into the carousel; `beers/[slug]` renders a
  single beer with `generateMetadata` + JSON-LD. `isPublic`/`sortOrder` drive
  visibility and ordering; `status` (`core`/`seasonal`/`limited`) is display
  metadata.
- **Venue data:** `getVenues()` queries `venues` where `isPublic == true`,
  ordered by `sortOrder`. `/where-to-buy` groups by `locationName` with island
  normalization (Saba / SXM / Statia), maps `carriesBeerSlugs`/`tapBeerSlugs`/
  `canBeerSlugs` to beer names, and renders `VenueCard` entries with their
  `links` and `notesPublic`.
- **Images:** stored in Firebase Storage; documents persist path strings
  (`images.cardPath`/`heroPath`) resolved to public URLs at render time
  (`beerImageUrl`).
- **Caching/rendering:** pages have no explicit `revalidate`/`dynamic`
  exports; `next build` prerenders them using whatever Firestore returns at
  build time. This means **content changes require a rebuild** — which is
  exactly what the admin rebuild trigger exists for (§10). `/beers/[slug]`
  renders on demand. There is no ISR; "rebuild" = full Vercel deploy via hook.

## 10. Admin content-management flows

All of these live in `components/admin-dashboard.tsx` (client) plus
`components/admin-access.tsx` (client) calling protected APIs.

| Operation | Mechanism | Enforcement |
| --- | --- | --- |
| Load beers/venues | Client SDK reads (all docs, `sortOrder` asc — including non-public) | Rules: public sees `isPublic` only; active admin (claim + matching record) reads all |
| Save beer / venue | Client SDK `setDoc(doc(db, "beers"|"venues", slug), payload, { merge: true })` — doc id is the slug | `hasActiveAdmin` in `firestore.rules` (claim + active matching `adminUsers` record) |
| Upload images | Client SDK `uploadBytes` to Storage | `hasActiveAdmin` in `storage.rules` (claim + cross-service `firestore.get()` active-record check) |
| Update rebuild metadata | Client SDK `setDoc` merge on `meta/siteRebuild` (`contentUpdatedAt/By`, `lastTriggeredAt/By`, `cooldownUntil`) | rules gate `meta` to active admins |
| Trigger rebuild | `POST /api/admin/rebuild` with Bearer token | Server: `requireAdminActor` (claims + active matching `adminUsers` record) + in-memory cooldown → POST to Vercel deploy hook |
| Check own status | `GET /api/admin/me` | Server: token verification |
| Bootstrap first superadmin | `POST /api/admin/bootstrap` | Server: `SUPER_ADMIN_EMAIL` match + claim/record reconcile |
| Accept invitation | `POST /api/admin/invitations/accept` | Server: transaction + claim assignment + rollback |
| List admins + invitations | `GET /api/admin/users` | Server: superadmin |
| Create invitation | `POST /api/admin/users` | Server: superadmin + Resend send |
| Resend invitation | `POST /api/admin/invitations/[id]/resend` | Server: superadmin + transactional cooldown claim |
| Change role / disable admin | `PATCH/DELETE /api/admin/users/[uid]` | Server: superadmin + `admin-policy` guards (last-superadmin protection) |

So: **content writes are client-SDK + rules; access/identity/rebuild operations
are Admin-SDK API routes.** Both paths are authorization-checked; the split is
intentional, not an oversight.

## 11. Trade inquiry flow

`components/trade-inquiry-form.tsx` (client) → `POST /api/trade-inquiry`
(server) → Firestore `tradeLeads` write (Admin SDK) → Resend notification
email. **Firestore is the durable system of record; email is a best-effort
notification.** (Owner decision, #57.)

1. **Form:** fields for business name, contact name, email, phone/WhatsApp
   (optional), venue type, message (optional), plus a hidden `website` honeypot.
   The submit button is disabled while a submission is in flight, preventing
   obvious double-submits; there is no server-side dedupe — a genuine retry
   (e.g. after a network failure) should create a lead, and the per-IP rate
   limit bounds abuse.
   Client-side state drives start/success/error analytics events
   (`trade_form_start`, `trade_form_success`, `trade_form_error`, category
   `conversion`).
2. **API route:** `app/api/trade-inquiry/route.ts` validates and rate-limits,
   then delegates to `submitTradeInquiry()` in `lib/trade-leads.ts`
   (server-only). The route:
   - requires `businessName`, `contactName`, `email`, `venueType` (400 on
     missing);
   - rejects oversized fields with 400 — `TRADE_LEAD_FIELD_LIMITS` in
     `lib/trade-leads-common.ts` bounds each persisted field so a huge
     submission is invalid input rather than a Firestore write failure;
   - treats a filled `website` honeypot as spam and **returns fake `ok: true`
     without persisting or notifying**;
   - applies an in-memory rate limit — max 5 requests per client IP per
     10 minutes (`x-forwarded-for`/`x-real-ip`), 429 beyond that. Being a
     per-instance `Map`, it resets on cold start and does not coordinate
     across serverless instances.
3. **Persistence:** `persistTradeLead()` writes the inquiry to `tradeLeads`
   via the Admin SDK (`buildTradeLeadRecord()` in
   `lib/trade-leads-common.ts` shapes the document). Orchestration lives in
   `processTradeInquiry()` — injectable and unit-tested. Only validated form
   fields plus `status`, `source`, and server timestamps are stored — never
   IPs, headers, honeypot values, or analytics identifiers.
4. **Notification:** after a successful write, the Resend email goes to
   `TRADE_INQUIRY_TO_EMAIL` from `RESEND_FROM_EMAIL` (defaulting to the
   shared `noreply@mail.deepdivebrewing.com` sender in `lib/resend-config.ts`),
   `replyTo` set to the submitter's email, values HTML-escaped, and the lead
   document id included as an operator reference. The Resend client is built
   **lazily at send time** via `getResendClient()` (`lib/resend.ts`), so
   `next build` needs no Resend value.
5. **Response/error handling:**
   - persistence + notification succeed → `ok: true`;
   - persistence succeeds but notification fails/misconfigured → `ok: true`
     and `trade_inquiry.notification_failed` is logged with the lead id
     (the inquiry is durably received — do not alarm the customer);
   - persistence fails → 500 generic error and
     `trade_inquiry.persistence_failed` is logged.
6. **Privacy/security:** submitted PII (business/contact/email/phone/message)
   is stored in `tradeLeads` — readable only via the Admin SDK / Firebase
   console since rules deny all client access — and transits to Resend and
   the configured inbox. Spam controls are the honeypot plus the per-instance
   IP rate limit — no captcha. The route is unauthenticated by design.

## 12. Analytics and observability

- **GA4 via GTM:** `app/layout.tsx` renders `components/gtm-bootstrap.tsx`
  (gtm.js via `next/script`, container id from `NEXT_PUBLIC_GTM_ID`, no
  default), gated to `VERCEL_ENV === "production"` so previews/local/CI
  never send events; the component additionally renders nothing on
  `/admin*` paths. `lib/analytics.ts` exposes a typed
  `trackEvent(name, params)` helper that pushes
  `{ event: name, ...params }` to `window.dataLayer` with a fixed
  event-name union; pushes are refused on `/admin` pathnames and failures
  never propagate (consent, ad-blockers, SSR, non-production).
- **Page views:** the application owns all `page_view` generation —
  `components/page-view-tracker.tsx` pushes `page_view` on the initial
  mount and each App Router navigation (excluding `/admin*`); the GTM
  Google tag is configured `send_page_view=false`, so nothing else emits
  page views and duplication is impossible by construction.
- **Consent:** bundled Klaro (`klaro` npm package, BSD-3-Clause —
  self-hosted, no vendor service or ID) + Google Consent Mode v2.
  `lib/consent.ts` builds the GTM init script so `consent default`
  (denied) is pushed before `gtm.start`, declares the service registry
  (`CONSENT_SERVICES`), maps Klaro choices to `consent update`s, and
  builds the local Klaro config (policy-versioned cookie storage).
  `components/consent-manager.tsx` lazy-loads Klaro on public pages in
  every environment and returns null on `/admin*`; a footer "Cookie
  preferences" control (`components/consent-settings-link.tsx`) reopens
  the manager. Full architecture and owner checklists:
  `docs/operations/analytics.md`.
- **Google Maps (contextual consent, not Klaro):** the `/contact` embed is
  click-to-load — `components/contact-map.tsx` renders an intentional
  placeholder with **Load map** / **Get directions** actions and inserts
  the iframe only on explicit click. The choice is component state (never
  persisted, never reads `ddb-consent-v1`) and works whether analytics
  consent is granted or denied — Maps is a functional embed, not an
  analytics service, so it does not belong to Consent Mode signals.
  `frame-src` still allows `https://www.google.com` for the embed itself;
  the **Get directions** link is a user-initiated external navigation,
  not an embedded frame.
- **Custom events:** `beer_detail_view` (`BeerViewTracker` on beer detail),
  `trade_form_start/success/error` (`trade-inquiry-form`), `beer_filter`
  (`beers-filter-grid`), and outbound/CTA clicks via `TrackedLink`/
  `TrackedAnchor` and the declarative `data-analytics-event` attribute
  handled by `AnalyticsClickTracker` (delegated click listener, whitelisted
  snake-cased params via `collectAnalyticsParams`). Canonical taxonomy:
  `docs/operations/analytics.md`.
- **Vercel Analytics & Speed Insights:** `@vercel/analytics/next` `<Analytics/>`
  and `@vercel/speed-insights/next` `<SpeedInsights/>` mounted in the root
  layout — no config, automatic page-view/Web-Vitals collection.
- **Logging/diagnostics:** server code emits single-line structured JSON via
  `lib/log.ts` (`logInfo`/`logWarn`/`logError`, stable dot-namespaced event
  names, `requestId` correlation via `x-vercel-id`, defensive sensitive-key
  filtering). API catch blocks funnel through `apiErrorResponse`
  (`lib/api-error.ts`): `clientSafe` errors (e.g. `AdminAuthError`) keep
  their deliberate message/status; everything else is logged in full
  server-side and answered with a generic 500. `app/error.tsx` and
  `app/not-found.tsx` provide branded error/404 boundaries. There are no
  dashboards, alerts, or error-tracking integrations — see
  [docs/operations/observability.md](operations/observability.md) for the
  event-name table, log-safety rules, and how to correlate user reports.
- **Scope notes:** the observability audit landed under **Issue #20**
  (structured logs, consistent API error shape, error/404 boundaries, smoke
  suite now also fails on 5xx documents). The analytics-quality audit (event
  coverage, naming, conversion accuracy) remains owned by **Issue #24**.

## 13. Environment configuration

Names only — never commit values. Source of truth for names:
`.env.local.example` plus actual `process.env` reads in code.

### Public client configuration (`NEXT_PUBLIC_*`, baked into the client bundle)

| Variable | Role | Required? |
| --- | --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase client config | Runtime only — needed for real data/sign-in; `next build` succeeds without it (prerender reads resolve empty) |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase client config | Runtime only |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase client config | Runtime only |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Firebase client config | Runtime only |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Firebase client config | Runtime only |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase client config | Runtime only |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | Firebase/GA measurement | Optional in code, used by GA fallback |
| `NEXT_PUBLIC_SITE_URL` | Canonical/OG/sitemap/robots base URL | Optional — defaults to `https://deepdivebrewing.com` everywhere |
| `NEXT_PUBLIC_GTM_ID` | GTM container id (`GTM-XXXXXXX`) | Production only — no default; the GA4 id `G-5VBQTMP37H` lives in the GTM container config |

### Server-only secrets/config

| Variable | Role | Required? |
| --- | --- | --- |
| `RESEND_API_KEY` | Resend client (lazy `getResendClient()`); supplied by the Vercel-managed Resend integration in deployed environments | Runtime only — required when mail is actually sent; trade route logs `trade_inquiry.notification_failed` (lead is already persisted), invitation send returns a structured failure |
| `RESEND_EMAIL_DOMAIN` | Injected by the Vercel Resend integration | **Not consumed** — explicit sender addresses are used instead |
| `TRADE_INQUIRY_TO_EMAIL` | Trade inquiry notification recipient | Runtime only — if unset the lead still persists and `trade_inquiry.notification_failed` is logged |
| `RESEND_FROM_EMAIL` | Shared default sender (trade emails; fallback for invites) | Optional — defaults to `Deep Dive Brewing <noreply@mail.deepdivebrewing.com>` (`DEFAULT_RESEND_FROM_EMAIL` in `lib/resend-config.ts`, on the verified sending domain) |
| `ADMIN_INVITE_FROM_EMAIL` | Invite sender (preferred) | Optional — falls back to `RESEND_FROM_EMAIL`, then the shared default |
| `FIREBASE_ADMIN_PROJECT_ID` | Admin SDK credential | Yes for all `/api/admin/*` |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | Admin SDK credential | Yes for all `/api/admin/*` |
| `FIREBASE_ADMIN_PRIVATE_KEY` | Admin SDK credential (PEM; stored with `\n` escapes) | Yes for all `/api/admin/*` |
| `SUPER_ADMIN_EMAIL` | Bootstrap allowlist — the only email `admin/bootstrap` will promote | Yes for bootstrap |
| `SENTRY_DSN` | Server-side error monitoring ingest (`lib/monitoring.ts`) | Optional — reporting is enabled only when this is set **and** `VERCEL_ENV=production`; preview/dev/CI never emit events |

### Operational/deployment configuration

| Variable | Role | Required? |
| --- | --- | --- |
| `VERCEL_DEPLOY_HOOK_URL` | Rebuild trigger target | Required for `/api/admin/rebuild` |
| `VERCEL_REBUILD_DEPLOY_HOOK_URL` | Fallback hook URL | Optional fallback (supported in code; not in `.env.local.example`) |
| `ADMIN_REBUILD_COOLDOWN_MS` | In-memory rebuild cooldown | Optional — defaults to 10 min |
| `ADMIN_INVITE_RESEND_COOLDOWN_MS` | Invitation resend cooldown | Optional — defaults to 60 s |

### CI build environment

`next build` in `.github/workflows/ci.yml` runs with **no environment
variables at all** — verified experimentally after the lazy-initialization
refactor (issue #18). Resend is only constructed at send time via
`getResendClient()` and Firebase client services only via `getFirebase*()`
first-use getters, so page-data collection evaluates no service clients.
Static generation still invokes the Firestore reads in `getBeers()` /
`getVenues()`, which fail fast against an unconfigured project
(`INVALID_ARGUMENT` warnings), fall back to offline mode, and resolve empty —
pages build with fallback/empty states. Typecheck/lint/tests need no env
either. No secrets or placeholder values exist anywhere in CI.

## 14. Testing and verification strategy

- **Runner:** Node's built-in `node:test` with `tsx` (`npm test` runs
  `node --test "tests/**/*.test.ts"`). The glob requires Node ≥ 21 — satisfied
  by the repository's Node 24 runtime (on Node 20 the pattern silently matched
  zero files, which is why the runtime was normalized).
- **Coverage (104 tests, all in `tests/`):** admin auth/claim parsing
  (`admin-auth`), admin-users record building/serialization, invitation
  policy/email/resend/cooldown logic, audit helpers, `admin-policy` mutation
  guards and the `checkAdminActorRecord` active-record policy,
  service-initialization config (`resend-config` key validation and sender
  selection, `lib/firebase.ts` import-time laziness/first-use caching), and
  **rules-content tests** that read `firestore.rules` and `storage.rules` as
  text and assert required patterns.
- **Emulator rules tests (`rules-tests/`, 27 tests):** `npm run test:rules`
  wraps `firebase emulators:exec --only firestore,storage` and evaluates the
  real rules via `@firebase/rules-unit-testing` — active/disabled/missing
  `adminUsers` records, role mismatches in both directions, unauthenticated
  and non-admin callers, public reads, the `tradeLeads` schema, superadmin
  collections, audit immutability, and the Storage cross-service lookup. Each
  test file uses its own `demo-*` project so parallel `node:test` files never
  share emulator state. (`firebase-tools` and `@firebase/rules-unit-testing`
  are devDependencies; Java is required locally for the emulator.)
- **CI (`.github/workflows/ci.yml`):** on PRs to `main` and pushes to `main` —
  `npm ci`, `npm run check:react-versions`, `npx tsc --noEmit`, `npm run lint`,
  `npm test`, `npm run test:rules` (Firestore/Storage emulators, no
  credentials — `demo-*` project IDs), `npm run build` (no env needed at
  all), `npx playwright test` (Chromium-only browser smoke tests against the
  build's `next start` output; traces/screenshots uploaded only on failure),
  `npm run check:md-links`.
  `permissions: contents: read`; no secrets, no deploy step.
- **Browser smoke tests (`smoke-tests/`):** Playwright suite run by CI after
  the build; Playwright's `webServer` starts `next start` on a fixed local
  port. Credential-free and deterministic — cross-origin requests (GA4,
  Firebase, etc.) are aborted and Vercel's `/_vercel/*` script endpoints are
  stubbed, so the suite never touches production services and asserts the
  stable shells/empty states that render without Firestore data. Covers the
  homepage, `/beers`, the `/beers/[slug]` not-found path, `/about`, `/trade`,
  `/contact`, `/where-to-buy`, and the `/admin` sign-in shell. Chromium only —
  it is a regression safety net, not a cross-browser matrix. Run locally with
  `npm run test:smoke` (builds first); a prior `npm run build` lets
  `npx playwright test` reuse it. It intentionally does not cover
  authenticated admin flows against real auth, real form submissions, or
  cross-browser checks. `smoke-tests/accessibility.spec.ts` adds axe-core
  scans of the same deterministic routes (serious/critical violations fail;
  lesser findings are reported non-blocking) plus keyboard/skip-link/
  mobile-menu/reduced-motion assertions. `smoke-tests/admin-accessibility.spec.ts`
  covers the authenticated admin dashboard via `/admin-fixture` — a
  request-time env-gated route (`ADMIN_A11Y_FIXTURE`, set only by the
  Playwright `webServer`) that renders the real `AdminWorkspace`/
  `AdminAccessPanel` components with fixture data and Playwright-mocked
  `/api/admin/*` calls; axe scans each tab and assertions cover record-list
  `aria-current`, required markers, status announcements, named confirm
  dialogs, and per-row accessible names. See
  [`docs/operations/accessibility.md`](./operations/accessibility.md).
- **Local-only scripts (`scripts/`):** Playwright-based manual diagnostics
  (`screenshot-check`, `overflow-check`, `hero-video-*`),
  `optimize-assets.mjs`, and Admin-SDK utilities (`bootstrap-superadmin.ts`,
  `prune-trade-leads.ts`, `seed-beers.ts`, `seed-venues.ts`). These remain
  manual/local; the CI smoke suite lives in `smoke-tests/`.
- **Verification parity:** local pre-PR checks are the same commands CI
  runs, per `AGENTS.md`.

## 15. Security boundaries

| Boundary | Mechanism |
| --- | --- |
| Admin identity | Firebase Auth + custom claims (`admin`, `role`) + an existing, active `adminUsers` record whose role matches the claims — all checked server-side per privileged request via `requireAdminActor`/`requireSuperAdminActor`. |
| Privileged server access | Admin SDK in `server-only` modules, initialized from `FIREBASE_ADMIN_*`; never shipped to the client. |
| Client SDK writes | `firestore.rules` / `storage.rules`: `hasActiveAdmin` gates content reads/writes (claim + existing, active, role-matching `adminUsers` record via `get()`/`firestore.get()`); `adminUsers`/`adminInvitations`/`adminAuditLogs` require `hasActiveSuperAdmin` (audit logs immutable — no client update/delete); catch-all denies everything else. |
| Protected API routes | Every privileged `/api/admin/*` operation verifies the Bearer ID token, re-checks claims, and requires the actor's `adminUsers` record to be active and role-consistent; admin-mutation routes apply `admin-policy` guards (superadmin-only mutations, last-superadmin protection). Bootstrap and invitation-accept are documented lifecycle exceptions. |
| Rebuild authorization | `requireAdminActor` check (token + `admin` claim + active matching record) before the Vercel hook is called; hook URL is a server secret. |
| Environment secrets | Server-only vars never prefixed `NEXT_PUBLIC_`; CI uses no env at all; `.env.local` is gitignored. |
| Security headers / CSP | `next.config.ts` `headers()` sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security`, and a CSP allowing self + Firebase/GA/Vercel origins; `redirects()` forces HTTPS + apex domain. |
| Audit trail | `adminAuditLogs` records sensitive admin actions (best-effort writes). |
| Spam boundary | Trade form honeypot (fake success) + per-instance in-memory IP rate limit (5/10 min); unauthenticated endpoint writes nothing. |

`SECURITY.md` documents the vulnerability-reporting policy and the
public-vs-secret configuration split;
[`docs/operations/credential-rotation.md`](./operations/credential-rotation.md)
is the operational rotation/recovery runbook; this section intentionally only
summarizes the implemented boundaries.

## 16. Known architecture debt / follow-up work

Findings are concrete and verified against code. Existing issues already cover
most of them; new debt found here is listed for a future issue rather than
fixed in this PR.

- **~~`/trade` duplicate page sources~~** — resolved by **#46**: the tabled
  `page.mdx` stub was removed after it proved to serve the route on Linux
  builds; `page.tsx` is the sole canonical source (see §4).
- **~~Trade inquiries were email-only~~** — resolved by **#57**: the owner
  decided Firestore is the system of record. `/api/trade-inquiry` persists
  leads via the Admin SDK (`lib/trade-leads.ts`); the Resend email is a
  best-effort notification whose failure no longer loses the inquiry. The
  old public-create `tradeLeads` rule was replaced with a deny-all client
  rule since no client access is needed.
- **~~Module-load Resend construction~~** — resolved by **#18**: the trade
  route and invitation email now share `getResendClient()` (`lib/resend.ts`),
  a lazy server-only singleton validated at send time, and `lib/firebase.ts`
  exposes lazy `getFirebase*()` getters. `next build` requires no env.
- **In-memory, per-instance state**: the rebuild cooldown in
  `/api/admin/rebuild` and the trade-inquiry rate limiter are both
  process-local (`Map`/module state) — they reset on cold start, do not
  coordinate across serverless instances, and the cooldown differs from the
  persisted `meta/siteRebuild.cooldownUntil` bookkeeping. Acceptable at
  current scale; worth revisiting under **#18/#20** follow-ups.
- **`content/` is a dead directory** (`.gitkeep` only); MDX lives under
  `app/(pages)`. Minor cleanup candidate.
- **No ISR/revalidation strategy**: public content is fully build-time; every
  content edit needs a full deploy-hook rebuild. Fine at current scale; a
  future consideration under performance work.

Issue-indexed follow-ups (unchanged scope, listed for orientation):

| Issue | Area |
| --- | --- |
| #12 | `SECURITY.md` rewrite / credential-rotation docs — **resolved**: `SECURITY.md` rewritten and `docs/operations/credential-rotation.md` added |
| #13 | Contribution templates |
| #14 | Dependabot — **resolved**: weekly npm + GitHub Actions updates via `.github/dependabot.yml` (grouped minor/patch tooling, individual runtime/major PRs, `type: dependencies` label, no auto-merge; react/react-dom declared-version alignment enforced in CI by `npm run check:react-versions`) |
| #16 | Node/runtime normalization — **resolved**: Node 24 via `.nvmrc` + `engines.node` (see §2) |
| #17 | Deterministic browser smoke tests in CI — **resolved**: `smoke-tests/` Playwright suite (Chromium) runs in Verify against the production build via `webServer` + `next start`; credential-free, externals intercepted (see §14) |
| #18 | Environment/service-initialization hardening — **resolved**: lazy `getResendClient()` + `getFirebase*()` getters; `next build` needs no env (see §13) |
| #20 | Observability — **resolved**: structured server logging (`lib/log.ts`), consistent API error responses (`lib/api-error.ts`), `x-vercel-id` request correlation in logs, branded `app/error.tsx`/`app/not-found.tsx` boundaries, smoke suite fails on 5xx documents (see §12 and `docs/operations/observability.md`) |
| #21 | Accessibility — **resolved**: axe-core scans (serious/critical gate) + keyboard/skip-link/reduced-motion assertions in `smoke-tests/accessibility.spec.ts`; carousel autoplay removed (WCAG 2.2.2 + brand rule), decorative media hidden from AT, global `:focus-visible` default, `prefers-reduced-motion` CSS, admin status live regions, trade-form `autocomplete`/required markers. Authenticated admin dashboard audited via `smoke-tests/admin-accessibility.spec.ts` + `/admin-fixture` (env-gated, fixture data, mocked admin APIs): tablist badge fix, record-list `aria-current`/list semantics, per-row action names, destructive-action styling + named confirms, required markers, input-border contrast (see `docs/operations/accessibility.md`) |
| #22 | SEO — **resolved**: apex `deepdivebrewing.com` confirmed as canonical (www→apex 308); robots.txt disallows admin/fixture/trade-placeholder/API surfaces; trade placeholders + 404 carry `noindex`; `/where-to-buy` OG/Twitter added (was inheriting root `og:url "/"`); beer detail gained `BreadcrumbList` JSON-LD + `#brewery` entity `@id`s; `smoke-tests/seo.spec.ts` asserts titles/descriptions/canonicals/noindex/robots/sitemap/JSON-LD in CI (see `docs/operations/seo.md`) |
| #23 | Performance — **resolved**: Firebase client SDK removed from public-route bundles (`beerImageUrl` moved to Firebase-free `lib/utils.ts`; SDK chunk now loads only on `/admin`); homepage `<video poster>` raw-image double-download replaced by an always-rendered `next/image` poster underlay; first `/beers` card marked `priority` (it was the route's lazy LCP image). Lab LCP on `/` 6.4s→3.7s, transfer −584KB; every route −~140KB. Source-assertion tests guard the boundaries; no CI score gate (see `docs/operations/performance.md`) |
| #24 | Analytics-quality audit — **resolved**: GA4 gated to production builds (`VERCEL_ENV`); SPA `page_view` added via `page-view-tracker.tsx` (verified gtag never saw client-side navigations); `/admin*` excluded; venue website clicks renamed `where_to_buy_click`→`retailer_click` with `partner_name`→`venue_slug`; added `email_click`, `social_click`, `beer_filter`; `beer_detail_view` status param fixed; PII-free param whitelist; `smoke-tests/analytics.spec.ts` + `tests/lib/analytics.test.ts` assert exact-once/param/PII semantics in CI (see `docs/operations/analytics.md`) |
| #29 | Harden admin authorization — **resolved**: privileged routes now require an active `adminUsers` record with role agreement via `requireAdminActor`/`requireSuperAdminActor` |
| #30 | Harden Firebase client-write authorization — **resolved**: `firestore.rules`/`storage.rules` now require an active, role-matching `adminUsers` record in addition to claims (Storage via cross-service `firestore.get()`); covered by emulator rules tests |
| #34 | Critical `next` advisories — **resolved**: `next`/`@next/mdx`/`eslint-config-next` 16.2.10 → 16.3.5 (vulnerable range `<=16.3.2`); transitive `sharp` 0.35.4, `postcss` 8.5.28 (override floor raised `^8.5.10` → `^8.5.23`), `nanoid` 3.3.19, `baseline-browser-mapping` 2.11.24. `npm audit --omit=dev` is clean; remaining findings are dev-only transitive deps |
| #46 | `/trade` route collision — **resolved**: `page.mdx` stub removed; `page.tsx` is the sole canonical route (collision resolution was platform-dependent — Windows served TSX, Linux served MDX). Smoke test asserts TSX-only markers (see §4) |
| #56 | GTM migration — **resolved**: direct `gtag.js` replaced by `components/gtm-bootstrap.tsx` (production + `NEXT_PUBLIC_GTM_ID` gated, never rendered on `/admin*`); `lib/analytics.ts` pushes canonical `{ event, ...params }` to `window.dataLayer` with push-time `/admin` exclusion; app owns all `page_view`s (GTM Google tag `send_page_view=false`); taxonomy unchanged (see §12 and `docs/operations/analytics.md`) |
