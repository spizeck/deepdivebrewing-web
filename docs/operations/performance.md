# Performance Reference

Performance and Core Web Vitals baseline for `deepdivebrewing.com` — audit
methodology, measured findings, asset conventions, and how to rerun the audit.

This document reflects the Issue #23 audit. Lab numbers below are
**diagnostics, not field data** — see [Lab vs. field](#lab-vs-field).

## Lab vs. field

| Source | What it is | What it is not |
| --- | --- | --- |
| Lighthouse (local production build, simulated mobile throttling) | Reproducible lab diagnostic. Good for finding bottlenecks and relative before/after comparisons. | Real-user Core Web Vitals. Simulated throttling inflates absolute numbers vs. real devices. |
| Vercel Speed Insights | Real-user field data (p75 LCP/CLS/INP) collected from production visitors via `@vercel/speed-insights`. | Not usable for pre-merge verification — a change must reach production before it shows up here. |
| Playwright/browser timing | Manual observation of specific behaviors. | Not a percentile metric. |

**Never claim a field CWV improvement from lab numbers.** After a perf PR
ships, check Speed Insights in the Vercel dashboard over the following
days/weeks to confirm real-user impact. At audit time Speed Insights had no
repository-visible tooling configured — treat dashboard review as a manual
post-deploy step.

## Baseline methodology (Issue #23)

Environment: Windows dev machine, Node 24, `next build` + `next start` on
localhost, Lighthouse 12 CLI (`npx -y lighthouse@12`), mobile form factor,
simulated throttling, headless Chrome. One run per route — treat ±0.3s LCP /
±50ms TBT differences as noise.

```bash
npm run build && npx next start -p 3100
CHROME_PATH="<chrome.exe>" npx -y lighthouse@12 http://localhost:3100/ \
  --form-factor=mobile --throttling-method=simulate \
  --output=json --output-path=home.json \
  --chrome-flags="--headless --no-sandbox"
```

Routes measured: `/`, `/beers`, `/about`, `/trade`, `/contact`,
`/where-to-buy`, `/beers/pale-lager` (representative beer detail; requires
Firebase config in `.env.local` for data — without it the route 404s).

### Baseline → post-change (single-run lab numbers)

| Route | LCP before → after | TBT before → after | Transfer before → after |
| --- | --- | --- | --- |
| `/` | 6.4s → 3.7s | 340ms → 130ms | 1325KB → 741KB |
| `/beers` | 3.9s → 3.0s | 320ms → 120ms | 777KB → 634KB |
| `/about` | 2.5s → 2.5s | 40ms → 200ms | 603KB → 460KB |
| `/trade` | 2.4s → 2.7s | 80ms → 90ms | 607KB → 463KB |
| `/contact` | 2.5s → 2.4s | 150ms → 100ms | 1041KB → 898KB |
| `/where-to-buy` | 2.5s → 2.5s | 60ms → 110ms | 606KB → 463KB |
| `/beers/[slug]` | 2.6s → 2.8s | 170ms → 90ms | 657KB → 513KB |

CLS was 0 on every route before and after. TBT deltas on the already-fast
routes are single-run noise; the transfer reduction (~140KB gzip of Firebase
client SDK no longer shipped/prefetched) is the durable change.

## Bottlenecks found and fixed

### 1. Firebase client SDK shipped to public routes — fixed

`components/beer-card.tsx` is rendered inside client components (the homepage
carousel and the `/beers` filter grid). It imported `beerImageUrl` from
`lib/beers.ts`, which top-level-imports `firebase/firestore` and
`lib/firebase.ts` (app + firestore + auth + storage). Turbopack bundled a
~144KB-gzip Firebase chunk into the public client graph: it loaded directly
on `/` (92% unused JS per Lighthouse) and was pulled onto every other route
by `<Link>` prefetch of `/beers`.

**Fix:** `beerImageUrl` moved to `lib/utils.ts` (already a client-shared,
Firebase-free module). The Firebase SDK chunk now loads only on `/admin`.

**Rule:** modules imported by client components must not transitively import
`firebase/*` or `lib/firebase.ts`. Data-fetching modules (`lib/beers.ts`,
`lib/venues.ts`) are server-side by convention — pure helpers needed by
client components belong in `lib/utils.ts` or a similarly clean module.
`tests/lib/beer-image-url.test.ts` guards this boundary.

### 2. Raw hero poster downloaded twice — fixed

The homepage hero section SSR'd `<video poster="/photos/herograin.jpg">`
(the `useMediaQuery` server snapshot renders the video branch). Browsers
fetch the `poster` attribute during HTML parse — before hydration, before
the IntersectionObserver viewport gating, and unaffected by
`preload="none"`. Every homepage visitor downloaded the 441KB raw JPEG *and*
the ~53KB optimized `next/image` version, and on slow connections the raw
file competed with the LCP image for bandwidth.

**Fix:** the optimized `next/image` poster now renders permanently under the
video; the `<video>` has no `poster` attribute and fades in over the image
when `canPlay`. Behavior (viewport gating, mobile/reduced-motion static
poster, ink overlay) is unchanged.

### 3. `/beers` LCP image was lazy-loaded — fixed

Lighthouse identified a lazy `BeerCard` image as the LCP element (3.9s).
`BeersFilterGrid` now passes `priority` to the first card only. Do not extend
`priority` further — it is a preload directive and overusing it just
re-creates the contention it solves.

## Findings reviewed and intentionally left alone

- **Hero video files** (`ddbwebvid.mp4` 13.3MB, `ddbwebvid.webm` 4.2MB):
  large, but the video only loads when the section scrolls into view on
  desktop without reduced-motion — it never competes with initial load.
  A lower-bitrate re-encode is a content/quality decision for the owner,
  not an engineering default.
- **`/beers/[slug]` is dynamic** (ƒ, server-rendered per request): beer
  slugs come from Firestore, and `generateStaticParams` would either require
  credentials at build time (violating the credential-free build guarantee
  from #18) or fall back to per-request rendering anyway. Static-izing with
  a credential-tolerant `generateStaticParams` + `dynamicParams` is a
  possible follow-up, not done here.
- **Google Maps embed** on `/contact` (~170KB third-party): now click-to-load
  (Issue #77) — zero third-party cost until the visitor requests it.
- **GA4 gtag.js** (~155KB): already `strategy="lazyOnload"`; third-party
  cost, acceptable per scope. Analytics semantics are #24's territory.
- **Fonts:** Inter via `next/font` (self-hosted, preloaded, 3 weights ~49KB)
  + Festival Budaya woff2 (20KB, `font-display: swap`). No issues found.
- **CLS:** 0 everywhere measured. Images use `fill` inside aspect-ratio
  containers — stable.
- **Carousel:** embla-carousel is small (~8KB); no autoplay; card images
  lazy by default; no change needed.
- **Admin dashboard:** out of scope; Firebase there is expected and correct.

## Conventions going forward

- **Only one `priority` image per route** — the actual likely LCP image.
  Everything else stays lazy. Guard: think "does this image paint above the
  fold on mobile?" If not, no `priority`.
- **Never put a `poster` attribute on a client-gated `<video>`** — it
  bypasses lazy/viewport loading. Render a `next/image` underlay instead.
- **Keep `lib/utils.ts` Firebase-free.** If a client component needs a value
  derived from a data module, extract the pure part rather than importing
  the fetching module.
- **Prefer `next/image` over raw files** for any image that renders on a
  page; raw `public/` files should be limited to icons, OG images, and
  other non-rendered assets.
- **Preserve reduced-motion behavior** when touching `hero-video.tsx` or
  anything with `animate-*` classes — the a11y smoke suite asserts it.

## CI performance gating — intentionally not added

No Lighthouse/score gate in CI: simulated-throttling scores on shared CI
runners are noisy enough to flake (±several points run-to-run is normal).
The durable regressions this audit found are structural — wrong module
imports, eager `poster` fetches, lazy LCP images — and are better guarded by
the source-assertion tests in `tests/lib/beer-image-url.test.ts` than by a
score threshold. If field data later shows a real CWV problem, revisit with
a specific budget tied to that problem.

## How to rerun the audit

1. `npm run build && npx next start -p 3100` (needs `.env.local` Firebase
   values for beer data; public pages still render without them).
2. Run Lighthouse per route with the command above; compare against the
   table in [Baseline](#baseline--post-change-single-run-lab-numbers).
3. Grep the build output for regressions:
   - `grep -l "firebase" .next/static/chunks/*.js` should list only chunks
     absent from public-route HTML.
   - `curl -s localhost:3100/<route> | grep -o 'src="[^"]*\.js"'` — check
     no unexpected chunks on public routes.
4. For field data, review Vercel Speed Insights after deploy.

## Intentionally unautomated checks

- Lighthouse runs (local only — see CI note above).
- Speed Insights dashboard review post-deploy.
- Filmstrip/visual verification that the hero still fades video over the
  poster and that reduced-motion shows the static poster (covered by the
  a11y smoke test for reduced motion).
