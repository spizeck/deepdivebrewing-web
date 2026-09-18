# Analytics Reference

Analytics and conversion-tracking baseline for `deepdivebrewing.com` —
systems, canonical event taxonomy, conversion candidates, privacy rules,
environment behavior, GTM configuration, and how to verify. Reflects the
Issue #24 audit and the Issue #56 GTM migration.

## Systems and their roles

| System | Role | Loaded |
| --- | --- | --- |
| **Cookiebot CMP** (`NEXT_PUBLIC_COOKIEBOT_ID`) | Visitor consent for analytics categories; drives Google Consent Mode signals | Production only — renders only when `VERCEL_ENV === "production"` AND the ID is set (see [Consent](#consent--cookiebot-cmp--google-consent-mode-v2)) |
| **Google Tag Manager** → **GA4** (`G-5VBQTMP37H`) | Marketing analytics: page views, custom events, funnels | Production only — the container script renders only when `VERCEL_ENV === "production"` AND `NEXT_PUBLIC_GTM_ID` is set; tag behavior gated by Consent Mode |
| **Vercel Analytics** (`@vercel/analytics`) | Independent page-view + Web Analytics product (cookieless, aggregate — outside CMP scope) | All builds (Vercel handles environment behavior internally) — not routed through GTM |
| **Vercel Speed Insights** (`@vercel/speed-insights`) | Field RUM for Core Web Vitals — see `performance.md` | All builds; do not remove — it's the field-perf source |
| `lib/log.ts` structured logs | Server observability | Server only — **separate system**, do not cross-wire |

GA4 (via GTM) and Vercel Analytics both record page traffic. That overlap is
intentional and harmless: GA4 is the marketing/funnel tool; Vercel Analytics
is the product analytics tool bundled with hosting.

The historical `G-MZT00CPF0Y` measurement ID sometimes cited in docs/issues
is stale — the live property is `G-5VBQTMP37H` (verified in production). The
measurement ID now lives in the **GTM container configuration**, not in the
application.

## Delivery architecture

```
Application → lib/analytics.ts → window.dataLayer → GTM container → GA4
```

- The **application** decides what happened: typed `trackEvent(name, params)`
  calls and `data-analytics-*` attributes define canonical business events.
- **`lib/analytics.ts`** pushes `{ event: <name>, ...params }` onto
  `window.dataLayer` (creating the queue if absent — it works whether or not
  GTM ever loads). Pushes are refused on `/admin*` paths.
- **GTM** is the delivery/configuration layer: a Custom Event trigger per
  event name forwards events and parameters to a GA4 event tag.
- **GA4** stores/reports — property `G-5VBQTMP37H`.

No GTM DOM scraping, CSS-selector triggers, or generic click triggers exist —
and none should be added. Application events are the only event source.

### dataLayer event shape

```json
{ "event": "trade_form_success", "venue_type": "bar", "cta_location": "trade_page" }
```

- `event` — the canonical event name (GTM Custom Event trigger key).
- All other keys — whitelisted event parameters, forwarded to GA4 by the
  event tag (see the parameter table below).
- Page views use the same shape: `{ "event": "page_view", "page_path": "/beers?x=1" }`.

## Environment behavior (production-only GTM)

`app/layout.tsx` renders `GtmBootstrap` only when
`process.env.VERCEL_ENV === "production"` **and**
`process.env.NEXT_PUBLIC_GTM_ID` is set. `VERCEL_ENV` is set by Vercel at
build time — `preview` on preview deploys, unset locally and in CI. Result:

- **Production with a configured ID:** gtm.js loads lazily
  (`lazyOnload`), the `gtm.start` push at `afterInteractive`.
- **Production without `NEXT_PUBLIC_GTM_ID`:** no container loads — a safe
  no-op state, not an error. There is deliberately no hardcoded default
  container ID. Likewise no `NEXT_PUBLIC_COOKIEBOT_ID` default exists.
- **Preview deploys / local dev / CI / Playwright:** no GTM or Cookiebot
  code at all — previews and tests can never contaminate the production
  property, and the suite runs fully offline from consent vendors.
- `trackEvent`/`sendPageView` push to `window.dataLayer` regardless; with no
  container the entries simply sit in the queue (or fail silently if the
  queue itself is broken) — analytics never breaks a link, form, or
  navigation.

## Page views — who owns what

**The application owns ALL `page_view` generation.** This is the deliberate,
explicit contract:

- **Initial landing view:** `components/page-view-tracker.tsx` pushes
  `{ event: "page_view", page_path }` on mount for non-admin paths.
- **SPA navigations:** the same tracker pushes one `page_view` per App
  Router client navigation.
- **GTM forwards, never originates:** the container's Google tag must have
  `send_page_view = false` so it does not emit its own automatic page view,
  and no GTM history-change trigger may exist. With the app as the sole
  producer, exactly-once holds by construction — including the edge case
  where a session navigates `/admin` → public and the container loads
  mid-session (no automatic page view can fire on container load).
- **`/admin*` (including `/admin-fixture`):** excluded on three layers —
  `GtmBootstrap` renders nothing, `pushToDataLayer` refuses to push on
  `/admin` pathnames so no marketing event can even reach the queue, and
  `AdminAnalyticsGuard` forces a full document load if a session enters
  `/admin*` in a document that already carries a live container (a public
  page → client-side transition — the root layout persists, and a loaded
  script cannot be unloaded; only a fresh document removes it). The guard
  is a no-op without a container, so direct admin entry and public
  browsing are unaffected.
- **GA4 Enhanced Measurement:** keep *Page views → "Page changes based on
  browser history events"* **OFF** — that would double-count against the
  app's SPA pushes.

## Canonical event taxonomy

All names are stable snake_case and locked to the `AnalyticsEventName` union
in `lib/analytics.ts` — TypeScript rejects unlisted names at the call site.
**The GTM migration changed no event names or semantics.**

| Event | Fires when | Params | Kind |
| --- | --- | --- | --- |
| `page_view` | Landing + each SPA navigation (app-pushed) | `page_path` | page view |
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
payloads; the smoke suite asserts typed form values never appear in
`dataLayer` pushes. All `trackEvent` params must stay non-PII by review —
the type allows strings, discipline supplies the rest.

## Consent — Cookiebot CMP + Google Consent Mode v2

When `NEXT_PUBLIC_COOKIEBOT_ID` is configured (production only, same gate as
GTM), visitor consent governs the Google tags via Consent Mode v2:

```
document → consent defaults (denied) → Cookiebot uc.js → consent updates
        → gtm.start → gtm.js → app dataLayer events → GTM → GA4
```

### Ordering — the part that must not regress

- `components/gtm-bootstrap.tsx` emits ONE inline script
  (`buildGtmInitScript` in `lib/consent.ts`) that pushes
  `gtag("consent","default", CONSENT_DEFAULTS)` onto `dataLayer` **before**
  `gtm.start`. A `window.gtag` stub is defined so both this default and
  Cookiebot's later `consent update` calls serialize onto the same command
  queue the Google tag drains. Because the default entry is pushed by the
  same script — and `gtm.js` only loads at `lazyOnload` — no Google tag can
  evaluate before the denied state exists.
- `GtmBootstrap` mounts **before** `PageViewTracker`/`AnalyticsClickTracker`
  in `app/layout.tsx` for the same reason: scripts execute in mount order,
  so the first `page_view` push also lands after the defaults. Do not
  reorder it below the trackers.
- Cookiebot `uc.js` loads `afterInteractive` with
  `data-blockingmode="none"`. **None** is deliberate: Consent Mode governs
  the Google tags at the data layer and there are no other trackers to
  block, so Cookiebot's auto-blocking could only interfere (GTM, Vercel
  scripts, navigation).
- Cookiebot maps its categories to Consent Mode signals automatically —
  statistics → `analytics_storage`; marketing → `ad_storage`,
  `ad_user_data`, `ad_personalization`; preferences →
  `functionality_storage`, `personalization_storage`; necessary →
  `security_storage` (always granted). The site runs analytics only — the
  ad signals exist because the v2 model includes them, not because ads do.

### Consent behavior

- **Defaults (all visitors, before choice):** `denied` for
  `analytics_storage`, `ad_storage`, `ad_user_data`, `ad_personalization`,
  `functionality_storage`, `personalization_storage`; `granted` for
  `security_storage`; `wait_for_update: 500` gives returning visitors' stored
  consent time to resolve before tags fire.
- **Events queued before consent resolves** are processed under the state
  at send time — under `denied`, the Google tag produces only cookieless,
  non-identifying hits per Google's Consent Mode model; nothing is
  retrospectively re-sent after an update. Deliberate: the app keeps
  pushing, and consent state — not queue manipulation — decides what GA4
  can store.
- **Unconfigured (`NEXT_PUBLIC_COOKIEBOT_ID` unset):** no CMP script and no
  consent defaults render — the site behaves exactly as before the
  integration. This is an absent integration, not an error; there is no
  hard-coded domain-group ID.
- **`/admin*`:** the same pathname gate that keeps GTM out also keeps
  uc.js and consent defaults out — admin documents carry no marketing
  analytics, so there is nothing to consent to. `AdminAnalyticsGuard` is
  unchanged; a fresh admin document contains no CMP either.

### Owner-side setup

**Cookiebot (cookiebot.com admin):**

1. Create the domain group for `deepdivebrewing.com`; copy the domain-group
   ID into the Vercel env var `NEXT_PUBLIC_COOKIEBOT_ID` (Production scope).
2. Banner: configure categories (necessary / preferences / statistics /
   marketing), texts, and branding. Enable the Google Consent Mode
   integration — Cookiebot auto-detects the `gtag consent` defaults this
   site emits.
3. Trigger a scan so the cookie declaration (rendered on `/privacy` via
   `cd.js`) lists real cookies.

**GTM container `GTM-MVTVCMDC` (in addition to the tag setup below):**

1. Admin → Container Settings → enable **Consent Overview**; verify each
   GA4 tag lists its built-in consent checks (`analytics_storage`, and the
   ad signals where shown). No additional consent checks are needed —
   built-in checks are what Consent Mode gates on.
2. Do **not** add a separate "consent initialization" tag — defaults are
   application-emitted before `gtm.start`, so a Consent Initialization tag
   would be redundant and risks ordering drift.
3. Keep `send_page_view=false` and Enhanced Measurement history-change
   page views OFF — unchanged by consent work.

**Rollback:** unset `NEXT_PUBLIC_COOKIEBOT_ID` (Vercel Production) and
redeploy — CMP, defaults, and declaration disappear together; GTM behavior
reverts to pre-CMP. To disable analytics entirely, unset
`NEXT_PUBLIC_GTM_ID` instead.

## GTM container configuration (operator, one-time)

The repository ships the application side only. The operator must create and
configure the container in Google Tag Manager (tagmanager.google.com):

1. **Container** — create a Web container for `deepdivebrewing.com`. Set the
   container ID as the Vercel env var `NEXT_PUBLIC_GTM_ID` (Production
   scope). No repo secret is involved — the ID is public configuration.
2. **Google tag (GA4 configuration)** — add a Google tag for measurement ID
   `G-5VBQTMP37H`, fired on container load (or `Initialization - All Pages`).
   In its configuration settings set **`send_page_view` = `false`** — the
   application owns all page views; without this the initial page view
   double-counts.
3. **Custom Event triggers** — one trigger per canonical event name,
   matching `event` equals e.g. `trade_form_success`. A single GA4 event tag
   can serve all triggers (the trigger supplies the event name), or one tag
   per event — operator preference. Do **not** create DOM/click/link
   triggers.
4. **GA4 event tag(s)** — tag type *GA4 Event*, measurement ID
   `G-5VBQTMP37H`. For `page_view` create a tag named `page_view` triggered
   by Custom Event `page_view`, forwarding the `page_path` data-layer
   variable (GA4 also auto-captures `page_location`/`page_referrer`). For
   business events, map each parameter in the taxonomy table as an event
   parameter via Data Layer Variables (e.g. `cta_location`,
   `venue_type`, `beer_slug`, `filter`, `social_network`, `island`,
   `venue_slug`, `beer_name`, `beer_style`, `beer_status`, `event_label`,
   `event_category`).
5. **Key event** — in GA4, mark `trade_form_success` as a key event. Do not
   mark weaker events as conversions.
6. **Enhanced Measurement** — in the GA4 web stream, keep *Page views →
   "Page changes based on browser history events"* **OFF** (double-count
   protection for SPA page views).

## Verification & debugging

- **Automated (CI):** `smoke-tests/analytics.spec.ts` asserts the absence of
  any GTM/gtag/Cookiebot bootstrap or consent commands in the test build,
  exactly-once `page_view` on landing and per SPA nav, zero dataLayer
  activity on `/admin` and `/admin-fixture`, a full-document reload boundary
  when a container-carrying document transitions into `/admin*`,
  exactly-once custom events with expected params, `trade_form_success`
  only on server acceptance, no form PII in any payload, and link
  navigation under a hostile dataLayer. `tests/lib/analytics.test.ts`
  unit-tests the push helper, the `/admin` gate, and the
  marketing-container detection used by the guard;
  `tests/lib/consent.test.ts` unit-tests the Consent Mode defaults and
  their ordering before `gtm.start`.
- **Manual (production):** GTM → Preview (Tag Assistant) against
  `https://deepdivebrewing.com`, plus GA4 → Reports → Realtime / DebugView:
  - land on `/` → exactly one `page_view`
  - navigate to `/beers` → exactly one more `page_view`
  - click a footer social icon → `social_click` with `social_network`
  - submit the trade form (or watch `dataLayer` in DevTools) →
    `trade_form_start` then `trade_form_success` only on acceptance
  - visit `/admin` → no GTM container, no events
  - inspect every payload in Tag Assistant → no PII fields
  - confirm preview/local traffic never appears in the property
- **Manual (consent, production only):** with Cookiebot configured —
  - first visit → banner shows; Tag Assistant's Consent tab shows all
    optional signals `denied` before choice
  - decline → no analytics cookies stored; only cookieless GA4 pings
  - accept statistics → `consent update` grants `analytics_storage`;
    `page_view` and events reach GA4 normally
  - `/privacy` → cookie declaration lists cookies and offers
    change/withdraw controls; reopening and declining stops cookie use on
    subsequent loads
  - Cookiebot/GTM blocked (ad-blocker) → site navigates and forms work;
    only banner/analytics are absent

## Cutover procedure (prevents double-counting)

The app no longer loads `gtag.js` — there is no app-side duplicate. The only
double-delivery risk is configuration drift:

1. Deploy this change. Without `NEXT_PUBLIC_GTM_ID`, production loads no
   analytics — a safe, event-free gap, not an error.
2. Configure the GTM container as above, **with `send_page_view = false`**.
   Publish the container.
3. Set `NEXT_PUBLIC_GTM_ID` in Vercel (Production) and redeploy.
4. Verify in Tag Assistant/DebugView (checklist above), then watch Realtime
   for ~24h for anomalies.
5. If rolling back is ever needed: remove `NEXT_PUBLIC_GTM_ID` and
   redeploy — do not restore a direct gtag integration alongside GTM.

## Adding a new event

1. Add the name to `AnalyticsEventName` and any new param to
   `AnalyticsEventParams` / `DATA_PARAM_KEYS` in `lib/analytics.ts`.
2. Prefer the declarative `data-analytics-*` attributes (handled by the
   delegated `AnalyticsClickTracker`) over per-element handlers.
3. Use a controlled `cta_location` value; stable slugs, not display text.
4. Ask: does this answer a business question page views don't already?
   If not, don't add it.
5. Add/extend a test; update the taxonomy table above.
6. Add a matching Custom Event trigger (+ parameter forwarding) in GTM.
