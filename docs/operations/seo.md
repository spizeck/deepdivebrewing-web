# SEO Reference

Technical SEO baseline for `deepdivebrewing.com` — canonical domain, indexing
policy, metadata conventions, sitemap/robots behavior, and how to verify.

## Canonical domain

**`https://deepdivebrewing.com`** (apex, no `www`) is the canonical host.

- `next.config.ts` issues permanent 308 redirects: `http` → `https` and
  `www.` → apex, one hop each at the application layer. (At the platform
  layer `http://www.` may take two hops through Vercel's own HTTPS upgrade —
  acceptable; domain config changes live in Vercel, not the repo.)
- `lib/site.ts` is the single source of truth for the site origin: `siteUrl`
  resolves `NEXT_PUBLIC_SITE_URL` with a fallback of
  `https://deepdivebrewing.com` and strips trailing slashes. It feeds
  `metadataBase`, canonical URLs, `og:url`, `robots.txt` (`Host` +
  `Sitemap`), `sitemap.xml`, JSON-LD entity URLs, and the redirect/CSP logic
  in `next.config.ts`. The code default is already the apex domain —
  production should keep the env var set to `https://deepdivebrewing.com`
  and nothing else.
- Canonical URLs must never point at Vercel preview deployments; the
  smoke suite asserts the apex host on every checked route.

## Indexing policy

| Surface | Indexed? | Mechanism |
| --- | --- | --- |
| `/`, `/beers`, `/beers/[slug]`, `/where-to-buy`, `/about`, `/contact`, `/trade`, `/privacy`, `/terms` | Yes | `index,follow` (root default); in `sitemap.xml` |
| `/beers/[slug]` unknown slug | No | `generateMetadata` returns `robots: { index: false }` + 404 |
| `/admin` | No | `robots` meta `noindex,nofollow` + `Disallow` in robots.txt; real protection is auth, not robots |
| `/admin-fixture` | No | `noindex,nofollow` meta + `Disallow`; also returns 404 unless the server-only test flag is set |
| `/carousel-fixture`, `/where-to-buy-fixture` | No | Same env-gated test-fixture pattern: `noindex,nofollow` meta + `Disallow`, 404 without the flag |
| `/trade/login`, `/trade/order`, `/trade/orders` | No | Reserved placeholders — `noindex,nofollow` meta + `Disallow` |
| `/api/*` | No | `Disallow: /api/` (API routes produce no indexable content) |
| `/_not-found` (404) | No | `noindex` meta + 404 status |

`robots.txt` is discoverability guidance, never a security boundary — private
routes stay protected by authentication.

## Metadata conventions

- Root `app/layout.tsx` defines `metadataBase`, the title template
  `%s | Deep Dive Brewing Co`, the default description, site-wide OG/Twitter
  defaults (`/photos/og-default.jpg`, `summary_large_image`), and icons.
- Every indexable page sets a unique `title`, a human-written `description`,
  a self-referencing `alternates.canonical`, and its own `openGraph.url`
  (a page without one would inherit the root `og:url: "/"` — that was a real
  bug fixed on `/where-to-buy`).
- Titles describe the page, not keyword lists. Descriptions are written for
  humans. `keywords` metadata exists on a few pages but is not load-bearing.
- `/beers/[slug]` uses `generateMetadata()` for per-beer title, description
  (name/style/ABV/tasting note), canonical, OG/Twitter cards, and the beer's
  hero image. When beer data is unavailable the route renders a noindex 404.
- Beer OG images declare no fixed dimensions — hero aspect varies.

## Sitemap

`app/sitemap.ts` emits static routes plus one URL per beer from `getBeers()`
at build time. Without Firestore credentials the data layer resolves empty,
so CI/no-env builds produce a sitemap with only static routes — a deliberate,
deterministic degradation (Issue #18 guarantee preserved; never make the
sitemap require credentials).

`lastModified` is intentionally omitted: the build has no real per-page
modification dates (beer/venue content changes in Firestore, not on
deploy), so a build-time stamp would misreport freshness to crawlers.

## Structured data (JSON-LD)

| Route | Types | Notes |
| --- | --- | --- |
| `/` | `Brewery` (`@id: <site>/#brewery`) | Canonical entity — built once by `buildBreweryJsonLd()` in `lib/brewery-json-ld.ts` |
| `/contact` | `Brewery` (`#brewery`) | Same builder — identical entity on every page |
| `/trade` | `Brewery` (`#brewery`) | Same builder — identical entity |
| `/where-to-buy` | `Brewery` (`#brewery`) + `FAQPage` | Same builder; FAQ mirrors the visible on-page questions |
| `/beers/[slug]` | `BreadcrumbList` | Mirrors the visible breadcrumb nav; no `Product` markup — see below |

Beer detail pages deliberately emit **no `Product` schema**. Google's
[product snippet requirements](https://developers.google.com/search/docs/appearance/structured-data/product-snippet)
mandate `offers`, `review`, or `aggregateRating`, and Deep Dive sells beer
only through retailers — none of those properties exist on these pages, so
a bare `Product` node only generated a Search Console error (Issue #81) while
misrepresenting the page as a purchase candidate. There is no other
Google-supported rich-result type that honestly describes a brewery's beer
page, so `BreadcrumbList` alone is the accurate model. Schema.org permits a
descriptive `Product`, but Google requires commerce/review data to make it
a valid result — and it must never be invented.

Rules: no fabricated `Offer`, price, rating, or review data — ever. Schema
must reflect real page content. All `Brewery` blocks come from a single
builder — `buildBreweryJsonLd()` in `lib/brewery-json-ld.ts` — fed by the
canonical business facts in `lib/site.ts` (name, legal name, email, address,
social URLs) and the `TELEPHONE_DISPLAY` derived in `lib/whatsapp.ts`, so
crawlers see one consistent entity (`@id: <site>/#brewery`) on every page.
Never hand-write a `Brewery` object in a page.

Every JSON-LD block is emitted through `serializeJsonLd` in `lib/json-ld.ts`,
which escapes HTML-unsafe characters (`<`, `>`, `&`, U+2028, U+2029) so a
stored value can never terminate the `<script>` element early. Never inline
`JSON.stringify(...)` into a `dangerouslySetInnerHTML` script — always use
the serializer.

## Social sharing

- Default card: `/photos/og-default.jpg` (1200×630, `summary_large_image`).
- Beer pages use the beer's own hero image.
- If a dedicated campaign OG image is ever needed, that's a design follow-up,
  not SEO plumbing.

## Internal linking

Primary nav + footer link every indexable page; beer cards link `/beers` →
`/beers/[slug]`; beer detail links back via the visible breadcrumb and a
"where to buy" link. No orphan indexable pages.

## Verifying SEO locally

```bash
npm run build && npm run start   # then inspect:
curl -s localhost:3000/robots.txt
curl -s localhost:3000/sitemap.xml
curl -s localhost:3000 | grep -E 'canonical|og:url'
npx playwright test smoke-tests/seo.spec.ts   # automated checks (runs in CI)
```

`smoke-tests/seo.spec.ts` asserts: unique title/description/canonical +
single `h1` per indexable route, `noindex` on private/placeholder surfaces,
robots.txt disallows + canonical `Sitemap`/`Host`, sitemap coverage and
host, and JSON-LD parseability/types.

## Post-deploy checks (manual)

- Fetch `https://deepdivebrewing.com/robots.txt` and `/sitemap.xml`; confirm
  the beer URLs appear (production builds have real data).
- Fetch a real beer page; confirm canonical, `og:image`, and the
  `BreadcrumbList` JSON-LD (no `Product` node — see Structured data above).
- Google Search Console (owned outside the repo): submit/refresh the
  sitemap, watch Coverage for unexpected `/admin` or `/trade/*` URLs.
