# Analytics Reference

Analytics and conversion-tracking baseline for `deepdivebrewing.com` —
systems, canonical event taxonomy, conversion candidates, privacy rules,
environment behavior, and how to verify. Reflects the Issue #24 audit.

## Systems and their roles

| System | Role | Loaded |
| --- | --- | --- |
| **GA4** (`gtag.js`, `G-5VBQTMP37H`) | Marketing analytics: page views, custom events, funnels | Production only — scripts render only when `VERCEL_ENV === "production"` |
| **Vercel Analytics** (`@vercel/analytics`) | Independent page-view + Web Analytics product | All builds (Vercel handles environment behavior internally) |
| **Vercel Speed Insights** (`@vercel/speed-insights`) | Field RUM for Core Web Vitals — see `performance.md` | All builds; do not remove — it's the field-perf source |
| `lib/log.ts` structured logs | Server observability | Server only — **separate system**, do not cross-wire |

GA4 and Vercel Analytics both record page traffic. That overlap is
intentional and harmless: GA4 is the marketing/funnel tool; Vercel Analytics
is the product analytics tool bundled with hosting.

The historical `G-MZT00CPF0Y` measurement ID sometimes cited in docs/issues
is stale — the live property is `G-5VBQTMP37H` (verified in production).

## Environment behavior (production-only GA)

`app/layout.tsx` renders the gtag scripts only when
`process.env.VERCEL_ENV === "production"`. `VERCEL_ENV` is set by Vercel at
build time — `preview` on preview deploys, unset locally and in CI. Result:

- **Production:** gtag loads lazily (`lazyOnload`), init at
  `afterInteractive`.
- **Preview deploys / local dev / CI / Playwright:** no gtag code at all —
  previews and tests can never contaminate the production property.
- `trackEvent`/`sendPageView` also no-op whenever `window.gtag` is missing
  (ad-blockers, consent denial, failures) — analytics never breaks a link,
  form, or navigation.

## Page views

- **Landing page:** sent by `gtag('config', GA_ID)` — GA4's standard initial
  page_view. Do not add a manual landing-page event; that double-counts.
- **Client-side navigations:** `components/page-view-tracker.tsx` emits
  `page_view` with `page_path` on each App Router navigation (verified: gtag
  does not observe Next.js route transitions by itself — enhanced
  measurement history tracking was not firing in lab testing).
- **`/admin*` is excluded** — admin activity belongs to the application
  audit logs, not marketing analytics.
- Duplicate-avoidance: the tracker skips its first render; if the GA4
  dashboard's *Enhanced Measurement → Page views → browser history events*
  is ever enabled, SPA navigations would double-count — keep it off.

## Canonical event taxonomy

All names are stable snake_case and locked to the `AnalyticsEventName` union
in `lib/analytics.ts` — TypeScript rejects unlisted names at the call site.

| Event | Fires when | Params | Kind |
| --- | --- | --- | --- |
| `page_view` | Landing (gtag config) + each SPA navigation | `page_path` | page view |
| `beer_detail_view` | Beer detail page mounts (`BeerViewTracker`) | `beer_slug`, `beer_name`, `beer_style`, `beer_status` | engagement |
| `beer_filter` | `/beers` filter button click | `filter`, `cta_location` | engagement |
| `where_to_buy_click` | CTA that navigates to `/where-to-buy` (homepage hero, homepage teaser, beer detail) | `event_label`, `cta_location`, `beer_*` on beer detail | intent |
| `retailer_click` | Venue **Website** link on `/where-to-buy` | `venue_slug`, `island`, `venue_type` | intent |
| `directions_click` | Venue **Directions** link on `/where-to-buy` | `venue_slug`, `island`, `venue_type` | intent |
| `whatsapp_click` | WhatsApp link on `/contact` | `cta_location` | lead intent |
| `email_click` | `mailto:` links (`/contact`, `/trade`) | `cta_location` | lead intent |
| `social_click` | Footer Facebook/Instagram/Untappd | `social_network`, `cta_location` | outbound |
| `tour_inquiry_click` | "Book a Brewery Tour" (WhatsApp) on `/` | `cta_location` | lead intent |
| `trade_form_start` | First field interaction on `/trade` | `cta_location` | engagement |
| `trade_form_success` | **Server accepted** the inquiry (`res.ok && data.ok`) | `venue_type`, `cta_location` | **conversion** |
| `trade_form_error` | Server rejection or network failure | `venue_type`, `cta_location` | diagnostic |

### Controlled parameter vocabulary

- `cta_location`: `homepage_hero`, `homepage_where_to_find_us`,
  `beer_detail_page`, `beers_page`, `where_to_buy_page`, `contact_page`,
  `trade_page`, `footer`, `header`. Do not invent new values casually.
- `filter`: `all` | `core` | `seasonal` | `limited`.
- `social_network`: `facebook` | `instagram` | `untappd`.
- Identifiers are stable slugs/types (`beer_slug`, `venue_slug`,
  `venue_type`, `island`) — never free-form content.

### Renames from pre-audit state (documented for reporting continuity)

- Venue website clicks used `where_to_buy_click` — renamed to
  `retailer_click` because they open the venue's external site, not the
  `/where-to-buy` page. Historical `where_to_buy_click` data mixes both
  meanings; post-deploy it means only nav-to-page.
- Venue param `partner_name` → `venue_slug` (stable identifier; the display
  name was free-form business text).
- `beer_detail_view` param `event_label` (status) → `beer_status`.

## Conversion candidates

| Tier | Events | Configure in GA4 as key events? |
| --- | --- | --- |
| Page view | `page_view` | No — base traffic |
| Engagement | `beer_detail_view`, `beer_filter`, `trade_form_start` | No |
| Lead intent | `whatsapp_click`, `email_click`, `tour_inquiry_click`, `directions_click`, `retailer_click`, `where_to_buy_click` | Maybe — owner's call; `directions_click`/`retailer_click` are the strongest commercial signals |
| **Successful lead** | `trade_form_success` | **Yes** — the primary conversion. Never mark `trade_form_error` or `trade_form_start` |

## PII rules

Never send to analytics: email addresses, names, phone numbers, form
contents/messages, Firebase UIDs, admin identities, IPs, tokens, invitation
emails, or URLs carrying sensitive query params. `collectAnalyticsParams`
whitelists dataset keys, so arbitrary `data-*` attributes cannot leak into
payloads; the smoke suite asserts typed form values never appear in gtag
calls. All `trackEvent` params must stay non-PII by review — the type allows
strings, discipline supplies the rest.

## Consent / privacy status (technical findings)

- No consent banner or Google Consent Mode exists. gtag loads on production
  for all visitors. The privacy policy already discloses Google Analytics +
  Vercel Analytics and cookie use.
- GA4 sets its own cookies on production visitors; Vercel Analytics is
  cookieless (aggregate). Admin routes send no GA events.
- Whether a CMP/consent gate is legally required for this audience is a
  product/legal decision — deliberately not decided by this audit.

## How to verify events

- **Automated:** `smoke-tests/analytics.spec.ts` mocks `window.gtag` and
  asserts exact event names/params, exactly-once firing, page_view on SPA
  nav, trade success/failure semantics, and no-PII — runs in CI.
  `tests/lib/analytics.test.ts` unit-tests the helper.
- **Manual:** DevTools → Network, filter `g/collect` (`en=` param = event
  name); or GA4 → Reports → Realtime / DebugView (`debug_mode` via the GA
  debugger extension). DebugView is optional, never required for CI.

## Adding a new event

1. Add the name to `AnalyticsEventName` and any new param to
   `AnalyticsEventParams` / `DATA_PARAM_KEYS` in `lib/analytics.ts`.
2. Prefer the declarative `data-analytics-*` attributes (handled by the
   delegated `AnalyticsClickTracker`) over per-element handlers.
3. Use a controlled `cta_location` value; stable slugs, not display text.
4. Ask: does this answer a business question page views don't already?
   If not, don't add it.
5. Add/extend a test; update the taxonomy table above.

## GA4 dashboard checklist (manual, owner-side — not done by this change)

- Confirm the property/stream is `G-5VBQTMP37H` and points at the apex host.
- Keep **Enhanced Measurement → "Page changes based on browser history
  events" OFF** — the repo now sends SPA page_views itself; both on = double
  counts.
- Mark `trade_form_success` as a **key event** (conversion).
- Optionally mark `directions_click` / `retailer_click` / `email_click` /
  `whatsapp_click` / `tour_inquiry_click` as key events.
- Verify no preview/localhost traffic appears (should be impossible now —
  no gtag outside production builds).
- Consider an internal-traffic filter for the owner's own visits.
