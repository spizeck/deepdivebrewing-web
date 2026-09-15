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
  against the configured project during prerendering. If reads are denied (for
  example, CI's dummy credentials), the SDK logs permission errors and the pages
  still build with fallback/empty states — see the code paths in `lib/beers.ts`
  and `lib/venues.ts` and the `Next.js prerendering error` / `permission-denied`
  warnings observed in build logs.
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
  in code. `firebase.json` configures Firestore/Storage rules files and
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
| `app/(pages)/` | Route group for all content pages — `about` (MDX), `admin`, `beers` (+`[slug]`), `contact`, `privacy`, `terms`, `trade` (+ `login`/`order`/`orders` "coming soon" placeholders), `where-to-buy` — sharing a `SiteHeaderDefault` layout. Most pages are `.tsx`; `about` and `trade` also contain `.mdx` variants — see §4. |
| `app/api/` | Server API routes: `admin/bootstrap`, `admin/invitations/accept`, `admin/invitations/[id]/resend`, `admin/me`, `admin/rebuild`, `admin/users` (GET list + POST create-invitation), `admin/users/[uid]` (PATCH/DELETE), and `trade-inquiry`. All are Admin-SDK-protected except `trade-inquiry`. |
| `components/` | App components: header/footer, home sections, cards, carousel/filter grid, analytics trackers, `admin-dashboard.tsx`, `admin-access.tsx`, `trade-inquiry-form.tsx`, `mdx-layout.tsx`. |
| `components/ui/` | shadcn/ui primitives (Radix-based) configured by `components.json`. |
| `lib/` | Shared logic. Client-safe: `firebase.ts`, `beers.ts`, `venues.ts`, `trade-leads.ts`, `analytics.ts`, `types.ts`, `utils.ts`, admin `*-common`/`admin-format.ts` helpers. Server-only (`import "server-only"`): `firebase-admin.ts`, `admin-auth.ts`, `admin-users.ts`, `admin-invitations.ts`, `admin-invitation-email.ts`, `admin-invitation-resend-core.ts`, `admin-audit.ts`. Policy/serialization helpers shared by both: `admin-policy.ts`, `admin-serializers.ts`, `admin-invitation-policy.ts`, `admin-invitation-resend-policy.ts`, `admin-types.ts`. |
| `tests/` | Node `node:test` unit tests (`tsx` loader) for admin/auth/invitation/audit helpers and for the *contents* of `firestore.rules` and `storage.rules`. |
| `scripts/` | Local/manual tooling: Playwright checks (`*-check.mjs`, `hero-video-network.mjs`), `check-md-links.mjs`, `optimize-assets.mjs`, `bootstrap-superadmin.ts`, `seed-beers.ts`, `seed-venues.ts`. None run in CI except `check-md-links.mjs`. |
| `docs/` | Admin handbook (`docs/admin/`), operations guides (`docs/operations/`: deployment, troubleshooting, post-deploy checklist), and this file. |
| `content/` | Legacy placeholder (`.gitkeep` only). MDX content is co-located under `app/(pages)/`; do not add files here expecting them to render. |
| `firestore.rules`, `storage.rules` | Firebase security rules — see §6/§15. |
| `firebase.json`, `.firebaserc`, `firestore.indexes.json` | Firebase project config (`deepdive-brewing` project), rules file mapping, and (empty) index config. |
| `.github/workflows/ci.yml` | CI — Node from `.nvmrc` (24), `npm ci`, typecheck, lint, tests, build, Markdown-link check. |
| `.env.local.example` | Documented environment variable names (values are never committed). |

**Intentional exception:** `components/admin-dashboard.tsx` performs
authenticated *client* SDK writes (`setDoc` on `beers`, `venues`,
`meta/siteRebuild`, and `uploadBytes` to Storage). This is deliberate — it is
gated by `hasAdminClaim` in the security rules — and is documented in
`AGENTS.md`. Do not "clean it up" by moving it into `lib/` or API routes
without an explicit issue.

## 4. Routing and page model

| Route | File | Server/Client | Data dependencies | Purpose |
| --- | --- | --- | --- | --- |
| `/` | `app/page.tsx` | Server (static) | `beers` collection via `getBeers()` | Home page; hero, featured beer/carousel, intro, brewery/CTA sections. |
| `/beers` | `app/(pages)/beers/page.tsx` | Server (static) | `beers` via `getBeers()` | Catalog grid; `BeersFilterGrid` (client) provides filtering. |
| `/beers/[slug]` | `app/(pages)/beers/[slug]/page.tsx` | Server (**dynamic**, no `generateStaticParams`) | `beers` via `getBeerBySlug(slug)` | Beer detail; `generateMetadata` per slug, JSON-LD, `BeerViewTracker` (client) emits `beer_detail_view`; 404 via `notFound()`. |
| `/where-to-buy` | `app/(pages)/where-to-buy/page.tsx` | Server (static) | `venues` + `beers` | Venue list grouped by island (Saba, SXM, Statia normalization in `islandDisplayName`), `VenueCard` entries. |
| `/about` | `app/(pages)/about/page.mdx` | Server (static) | none | MDX content styled by `mdx-components.tsx`. |
| `/contact` | `app/(pages)/contact/page.tsx` | Server (static) | none | Contact details; `TrackedAnchor` for click analytics. |
| `/trade` | `app/(pages)/trade/page.tsx` **(authoritative)** | Server (static) | none | Wholesale/trade page hosting `TradeInquiryForm` (client). See the `/trade` note below. |
| `/trade/login`, `/trade/order`, `/trade/orders` | `app/(pages)/trade/*/page.tsx` | Server (static) | none | Reserved "Coming soon" placeholders for a future trade portal. |
| `/privacy`, `/terms` | `app/(pages)/{privacy,terms}/page.tsx` | Server (static) | none | Legal text via `MdxLayout` + TSX content. |
| `/admin` | `app/(pages)/admin/page.tsx` | Server wrapper (`robots: noindex`) rendering the client `AdminDashboard` | Auth state, `beers`, `venues`, `meta/siteRebuild`, Storage | Admin dashboard. Auth checks happen client-side; real enforcement is in rules + APIs. |
| `/api/admin/*` | `app/api/admin/**` | Server (dynamic) | Admin SDK: Auth, Firestore | Bootstrap, `me`, users list/create-invitation, user patch/delete, invitation accept/resend, rebuild trigger. |
| `/api/trade-inquiry` | `app/api/trade-inquiry/route.ts` | Server (dynamic) | Resend | Validates the form payload and emails it; see §11. |
| `/sitemap.xml`, `/robots.txt` | `app/sitemap.ts`, `app/robots.ts` | Server (static — generated at build) | `beers` | SEO metadata routes; sitemap enumerates beer slugs at build time. Favicons are static files in `public/` referenced from `app/layout.tsx` metadata. |

### The `/trade` route: `page.tsx` vs `page.mdx`

`app/(pages)/trade/` contains **both** `page.tsx` and `page.mdx`. Next.js
resolves colliding page files in `pageExtensions` order
(`["ts","tsx","md","mdx"]` in `next.config.ts`), so **`page.tsx` wins and
`page.mdx` is unreachable dead code.** Verified against the built
`.next/server/app/trade.html`: it contains the TSX-only strings ("What to
expect", "Prefer email", the JSON-LD `schema.org` block, and the TSX metadata
description) and none unique to the MDX file.

The two files overlap heavily — the MDX version is an older, shorter variant of
the same page (both render `TradeInquiryForm`). This is tracked as technical
debt: `page.mdx` should be removed in a dedicated cleanup issue, but per this
issue's scope neither file was modified.

The same collision pattern exists nowhere else: `about` has only `page.mdx`,
and every other `(pages)` route has only `page.tsx`.

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
  public reads only of `isPublic` docs; admin-claimed clients can read all,
  which is how the dashboard lists non-public docs ordered by `sortOrder`.
- **Writes:** admin dashboard `setDoc(doc(db,"beers", slug), payload, {merge:true})`
  (client SDK) — requires `hasAdminClaim` per `firestore.rules`.
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

- **Purpose:** designed to store wholesale inquiries.
- **Fields (`TradeLead` in `lib/types.ts` / `lib/trade-leads.ts`):**
  `businessName`, `contactName`, `email`, `phoneOrWhatsapp`, `venueType`,
  `message`, plus `createdAt` (server timestamp) and `status: "new"`.
- **Current state:** `submitTradeLead()` in `lib/trade-leads.ts` writes to this
  collection via the client SDK, but **no code path calls it** — the form posts
  to `/api/trade-inquiry` which only emails. `firestore.rules` grants
  unauthenticated `create` restricted to exactly the documented fields with
  `status == "new"`, and `read`/`update`/`delete` to `hasAdminClaim` — so the
  collection is writable by the client if the helper were wired in, but in
  production today it is effectively unused. This is dead-code/discrepancy
  debt — see §11 and §16.

### `adminUsers`

- **Purpose:** source of truth (with custom claims) for who is an administrator.
- **Key fields (per `admin-users-common.ts`/`AdminUserView`):** `email`
  (normalized), `role` (`"admin" | "superadmin"`), `status`
  (`"active" | "disabled"`), `createdAt`, `createdBy`, `updatedAt`,
  `updatedBy`, optional `displayName` and `lastLoginAt`, plus revocation
  fields when disabled.
- **Reads/writes:** in practice server-side only via Admin SDK
  (`lib/admin-users.ts` and `app/api/admin/users*`). Rules technically allow
  `hasSuperAdminClaim()` client read/write, but no client code uses it.
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
  invitation API routes). Rules allow `hasSuperAdminClaim()` client read/write,
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

- **Client SDK** (`lib/firebase.ts`): initialized once with the
  `NEXT_PUBLIC_FIREBASE_*` config; exports `db` (Firestore), `auth`
  (Authentication), and `storage` (Storage). Used by:
  - public server components for build-time reads (`beers`, `venues`),
  - the admin dashboard for reads *and writes* (beers/venues/meta, Storage
    uploads), all gated by rules,
  - Google sign-in (`GoogleAuthProvider` + `signInWithPopup`) in the dashboard,
  - `lib/trade-leads.ts` (currently unused, see §5).
- **Admin SDK** (`lib/firebase-admin.ts`, `import "server-only"`): initialized
  lazily from `FIREBASE_ADMIN_*` credentials; exports admin `auth`/`db`. Used by
  every protected API route and the server-only `lib/admin-*.ts` modules for
  ID-token verification, custom-claim assignment, and privileged Firestore
  access that bypasses security rules.
- **Firestore:** `beers`/`venues` are publicly readable only where
  `isPublic == true` and admin-writable; `meta` is admin-only; `adminUsers`,
  `adminInvitations`, and `adminAuditLogs` are superadmin-claim-only in rules
  (audit logs additionally immutable — `update, delete: if false`); in practice
  only Admin SDK server code touches admin collections; `tradeLeads` allows a
  schema-validated public `create`. A catch-all rule denies everything else.
- **Storage:** `storage.rules` allows public reads and admin writes
  (`hasAdminClaim`); images are stored under the `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
  and referenced by path fields (`images.heroPath`, `imagePath`) resolved
  through `beerImageUrl`/the public download URL pattern.
- **Authentication:** Google sign-in only. Admin status is **not** the Auth
  account itself — it is the combination of (a) custom claims on the ID token
  and (b) a matching, active `adminUsers` document for the acting user,
  enforced per request on every privileged route (see §7).
- **Security rules** (`firestore.rules`, `storage.rules`): `hasAdminClaim()`
  checks `request.auth.token.admin == true`; `hasSuperAdminClaim()` adds
  `role == 'superadmin'`; `isPublicDoc()` gates public reads of
  `beers`/`venues`. Storage: world-readable, admin-writable. Rules are the
  enforcement boundary for client SDK traffic; API routes enforce separately
  via Admin SDK verification in `lib/admin-auth.ts`.
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
   by `hasAdminClaim` in `firestore.rules`/`storage.rules`.
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
   `lib/admin-invitation-email.ts`) constructs Resend **lazily inside the send
   function** (unlike the trade route, which constructs it at module load) and
   returns a structured failure if `RESEND_API_KEY` is unset rather than
   throwing. It builds the invite link from `NEXT_PUBLIC_SITE_URL`, sends from
   `ADMIN_INVITE_FROM_EMAIL` (falling back to `RESEND_FROM_EMAIL`), then
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
| Load beers/venues | Client SDK reads (all docs, `sortOrder` asc — including non-public) | Rules: public sees `isPublic` only; admin claim reads all |
| Save beer / venue | Client SDK `setDoc(doc(db, "beers"|"venues", slug), payload, { merge: true })` — doc id is the slug | `hasAdminClaim` in `firestore.rules` |
| Upload images | Client SDK `uploadBytes` to Storage | `hasAdminClaim` in `storage.rules` |
| Update rebuild metadata | Client SDK `setDoc` merge on `meta/siteRebuild` (`contentUpdatedAt/By`, `lastTriggeredAt/By`, `cooldownUntil`) | rules gate `meta` to admins |
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
(server) → Resend email. **No Firestore persistence occurs today.**

1. **Form:** fields for business name, contact name, email, phone/WhatsApp
   (optional), venue type, message (optional), plus a hidden `website` honeypot.
   Client-side state drives start/success/error analytics events
   (`trade_form_start`, `trade_form_success`, `trade_form_error`, category
   `conversion`).
2. **API route:** `app/api/trade-inquiry/route.ts` instantiates
   `new Resend(process.env.RESEND_API_KEY)` at **module top level** — this is
   why `next build` fails without a `RESEND_API_KEY` value and why CI supplies a
   dummy. The route then:
   - requires `businessName`, `contactName`, `email`, `venueType` (400 on
     missing);
   - treats a filled `website` honeypot as spam and **returns fake `ok: true`
     without sending**;
   - applies an in-memory rate limit — max 5 requests per client IP per
     10 minutes (`x-forwarded-for`/`x-real-ip`), 429 beyond that. Being a
     per-instance `Map`, it resets on cold start and does not coordinate
     across serverless instances;
   - HTML-escapes all submitted values before embedding them in the email
     template;
   - sends to `TRADE_INQUIRY_TO_EMAIL` (**required** — 500 "Destination email
     is not configured" if unset) from `RESEND_FROM_EMAIL` (defaulting to a
     hardcoded `Deep Dive Brewing <DeepDiveBrewing@mail.seasaba.com>`), with
     `replyTo` set to the submitter's email.
3. **Persistence:** none. `lib/trade-leads.ts` (`submitTradeLead`) and the
   `tradeLeads` collection + public-create rule exist, but the helper has **zero
   call sites**. If lead persistence is desired it must be wired in (or the dead
   code/rules removed) — flagged as debt in §16.
4. **Response/error handling:** the form shows a success state on `ok`; errors
   surface a retryable error message. Because nothing is stored, a Resend
   failure loses the inquiry entirely.
5. **Privacy/security:** submitted data (business/contact/email/phone/message)
   transits to Resend and the configured inbox only. Spam controls are the
   honeypot plus the per-instance IP rate limit — no captcha. The route is
   unauthenticated by design — it writes nothing privileged.

## 12. Analytics and observability

- **GA4:** `app/layout.tsx` loads the `gtag.js` script via `next/script` with
  `NEXT_PUBLIC_GA_ID` (hardcoded fallback `G-5VBQTMP37H`). `lib/analytics.ts`
  exposes a typed `trackEvent(name, params)` wrapper over `gtag` with a fixed
  event-name union; it silently no-ops when gtag is unavailable (consent,
  ad-blockers, SSR).
- **Custom events:** `beer_detail_view` (`BeerViewTracker` on beer detail),
  `trade_form_start/success/error` (`trade-inquiry-form`), partner/outbound and
  CTA clicks via `TrackedLink`/`TrackedAnchor` and the declarative
  `data-analytics-event` attribute handled by `AnalyticsClickTracker`
  (delegated click listener, snake-cases `data-analytics-*` params).
- **Vercel Analytics & Speed Insights:** `@vercel/analytics/next` `<Analytics/>`
  and `@vercel/speed-insights/next` `<SpeedInsights/>` mounted in the root
  layout — no config, automatic page-view/Web-Vitals collection.
- **Logging/diagnostics:** no structured logging or monitoring — server code
  uses `console.error`/`console.warn` (e.g. audit-write failures, metadata
  write failures, Firestore build-time permission errors). There are no
  dashboards, alerts, or error-tracking integrations.
- **Scope notes:** deeper observability (logging strategy, alerting, error
  tracking) is owned by **Issue #20**; the analytics-quality audit (event
  coverage, naming, conversion accuracy) is owned by **Issue #24**. Neither was
  performed here.

## 13. Environment configuration

Names only — never commit values. Source of truth for names:
`.env.local.example` plus actual `process.env` reads in code.

### Public client configuration (`NEXT_PUBLIC_*`, baked into the client bundle)

| Variable | Role | Required? |
| --- | --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase client config | Yes (build + runtime) |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Firebase client config | Yes |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Firebase client config | Yes |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Firebase client config | Yes |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | Firebase client config | Yes |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Firebase client config | Yes |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | Firebase/GA measurement | Optional in code, used by GA fallback |
| `NEXT_PUBLIC_SITE_URL` | Canonical/OG/sitemap/robots base URL | Optional — defaults to `https://deepdivebrewing.com` everywhere |
| `NEXT_PUBLIC_GA_ID` | GA4 measurement id | Optional — hardcoded `G-5VBQTMP37H` fallback in `app/layout.tsx` |

### Server-only secrets/config

| Variable | Role | Required? |
| --- | --- | --- |
| `RESEND_API_KEY` | Resend client (trade route constructs it at module load) | Yes — **`next build` fails without any value** |
| `TRADE_INQUIRY_TO_EMAIL` | Trade inquiry recipient | **Required** — route returns 500 if unset |
| `RESEND_FROM_EMAIL` | Sender for trade emails; fallback sender for invites | Optional — hardcoded default in the trade route |
| `ADMIN_INVITE_FROM_EMAIL` | Invite sender (preferred) | Optional — falls back to `RESEND_FROM_EMAIL` |
| `FIREBASE_ADMIN_PROJECT_ID` | Admin SDK credential | Yes for all `/api/admin/*` |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | Admin SDK credential | Yes for all `/api/admin/*` |
| `FIREBASE_ADMIN_PRIVATE_KEY` | Admin SDK credential (PEM; stored with `\n` escapes) | Yes for all `/api/admin/*` |
| `SUPER_ADMIN_EMAIL` | Bootstrap allowlist — the only email `admin/bootstrap` will promote | Yes for bootstrap |

### Operational/deployment configuration

| Variable | Role | Required? |
| --- | --- | --- |
| `VERCEL_DEPLOY_HOOK_URL` | Rebuild trigger target | Required for `/api/admin/rebuild` |
| `VERCEL_REBUILD_DEPLOY_HOOK_URL` | Fallback hook URL | Optional fallback (supported in code; not in `.env.local.example`) |
| `ADMIN_REBUILD_COOLDOWN_MS` | In-memory rebuild cooldown | Optional — defaults to 10 min |
| `ADMIN_INVITE_RESEND_COOLDOWN_MS` | Invitation resend cooldown | Optional — defaults to 60 s |

### CI dummy-env behavior

`.github/workflows/ci.yml` sets non-secret placeholder values for all seven
`NEXT_PUBLIC_FIREBASE_*` variables plus `RESEND_API_KEY=re_ci_dummy_key`
**only on the build step** — because `next build` evaluates route modules
(`new Resend(...)` at top level) and constructs the Firebase client during
page-data collection. The dummy Firebase project causes expected
`permission-denied` warnings during static generation; the build completes and
serves empty/fallback content. Typecheck/lint/tests need no env at all.
**Issue #18** owns hardening this initialization (e.g. lazy clients, clearer
validation); this document describes current behavior only.

## 14. Testing and verification strategy

- **Runner:** Node's built-in `node:test` with `tsx` (`npm test` runs
  `node --test "tests/**/*.test.ts"`). The glob requires Node ≥ 21 — satisfied
  by the repository's Node 24 runtime (on Node 20 the pattern silently matched
  zero files, which is why the runtime was normalized).
- **Coverage (79 tests, all in `tests/`):** admin auth/claim parsing
  (`admin-auth`), admin-users record building/serialization, invitation
  policy/email/resend/cooldown logic, audit helpers, `admin-policy` mutation
  guards, and **rules-content tests** that read `firestore.rules` and
  `storage.rules` as text and assert required patterns (e.g. `hasAdminClaim`,
  public-read/admin-write on `beers`/`venues`, admin-collection lockdown,
  `tradeLeads` create rule). They verify rule *contents*, not live evaluation
  (no emulator).
- **CI (`.github/workflows/ci.yml`):** on PRs to `main` and pushes to `main` —
  `npm ci`, `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`
  (with dummy env), `npm run check:md-links`. `permissions: contents: read`;
  no secrets, no deploy step.
- **Local-only scripts (`scripts/`):** Playwright-based checks
  (`console-check`, `screenshot-check`, `overflow-check`, `hero-video-*`,
  `analytics-check`, `local-admin-check`, `preview-admin-auth-check`),
  `optimize-assets.mjs`, and Admin-SDK utilities (`bootstrap-superadmin.ts`,
  `seed-beers.ts`, `seed-venues.ts`). **None of the Playwright checks run in
  CI** — they are manual/local. Deterministic browser CI is future work owned
  by **Issue #17**.
- **Verification parity:** local pre-PR checks are the same five commands CI
  runs (typecheck, lint, test, build, md-links), per `AGENTS.md`.

## 15. Security boundaries

| Boundary | Mechanism |
| --- | --- |
| Admin identity | Firebase Auth + custom claims (`admin`, `role`) + an existing, active `adminUsers` record whose role matches the claims — all checked server-side per privileged request via `requireAdminActor`/`requireSuperAdminActor`. |
| Privileged server access | Admin SDK in `server-only` modules, initialized from `FIREBASE_ADMIN_*`; never shipped to the client. |
| Client SDK writes | `firestore.rules` / `storage.rules`: `hasAdminClaim` gates content writes; `adminUsers`/`adminInvitations`/`adminAuditLogs` require `hasSuperAdminClaim` (audit logs immutable — no client update/delete); catch-all denies everything else. |
| Protected API routes | Every privileged `/api/admin/*` operation verifies the Bearer ID token, re-checks claims, and requires the actor's `adminUsers` record to be active and role-consistent; admin-mutation routes apply `admin-policy` guards (superadmin-only mutations, last-superadmin protection). Bootstrap and invitation-accept are documented lifecycle exceptions. |
| Rebuild authorization | `requireAdminActor` check (token + `admin` claim + active matching record) before the Vercel hook is called; hook URL is a server secret. |
| Environment secrets | Server-only vars never prefixed `NEXT_PUBLIC_`; CI uses dummies; `.env.local` is gitignored. |
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

- **`/trade` duplicate page sources** (`app/(pages)/trade/page.tsx` +
  `page.mdx`): `page.tsx` wins by `pageExtensions` order; the MDX file is
  unreachable duplicate content that can silently diverge (it already differs).
  **Recommend a follow-up issue to delete `page.mdx`** (kept here per scope).
- **Unused `tradeLeads` persistence**: `lib/trade-leads.ts` (`submitTradeLead`)
  and the public-create `tradeLeads` rule exist but nothing calls them —
  inquiries are email-only and lost on Resend failure. Decide between wiring
  persistence in `/api/trade-inquiry` or removing the dead code/rule.
  **Recommend a follow-up issue.**
- **Module-load Resend construction** in `app/api/trade-inquiry/route.ts`
  forces every build to provide a `RESEND_API_KEY` (reason for CI dummies).
  Covered by **#18** (environment/service-init hardening); the invitation
  email module already does lazy init and is the existing pattern to copy.
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
| #14 | Dependabot |
| #16 | Node/runtime normalization — **resolved**: Node 24 via `.nvmrc` + `engines.node` (see §2) |
| #17 | Deterministic browser smoke tests in CI (Playwright scripts are local-only today) |
| #18 | Environment/service-initialization hardening (dummy-env build, top-level `new Resend`) |
| #20 | Observability (only `console.*` logging today; no error tracking/alerts) |
| #21 | Accessibility |
| #22 | SEO |
| #23 | Performance |
| #24 | Analytics-quality audit |
| #29 | Harden admin authorization — **resolved**: privileged routes now require an active `adminUsers` record with role agreement via `requireAdminActor`/`requireSuperAdminActor` |
