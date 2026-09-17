# Accessibility

Current-state accessibility reference for the Deep Dive Brewing Co website,
plus the conventions and automated checks that keep it there. Reference point
is WCAG 2.2 AA — this is a practical baseline, not a certification.

## What is covered

| Surface | Coverage |
| --- | --- |
| `/`, `/beers`, `/about`, `/trade`, `/contact`, `/where-to-buy`, `/admin`, `/beers/[slug]` (404 path) | axe scan (serious/critical block) + keyboard checks |
| Authenticated admin dashboard (beers/venues tabs, forms, rebuild controls, access/invitation management) | axe scan + keyboard/status/focus assertions via `/admin-fixture` |
| `/admin` sign-in shell and unauthorized states | axe scan + live-region assertions (public-route spec) |

### The admin fixture route

`/admin-fixture` renders the real authenticated admin UI
(`AdminWorkspace` + `AdminAccessPanel`, the exact components `/admin` uses)
with hardcoded fixture records. It exists only when the server is started
with `ADMIN_A11Y_FIXTURE=1` — a server-side env check evaluated per request
(`force-dynamic`), set exclusively by the Playwright `webServer` config.
Everywhere else, including Vercel, it returns 404. It grants no real access:
no Firebase credentials, users, or data are involved; `AdminAccessPanel`'s
`/api/admin/*` calls are intercepted by Playwright route mocks, so its real
fetch/confirm/update logic still runs end to end.

This seam exists because the authenticated UI otherwise requires a signed-in
Firebase user with admin custom claims — no credential-free path can reach it
without weakening production auth, which is out of bounds. The split
(`AdminDashboard` keeps auth + Firestore orchestration; `AdminWorkspace` is
the props-driven view) keeps the tested markup identical to production.

## Automated checks

`smoke-tests/accessibility.spec.ts` (public routes) and
`smoke-tests/admin-accessibility.spec.ts` (authenticated admin via the
fixture) run in the same Playwright suite as the smoke tests
(`npx playwright test`, executed by CI after `npm run build`):

- **axe-core** (`@axe-core/playwright`) scans the routes above with WCAG
  2.0/2.1/2.2 A+AA tags. **Serious and critical violations fail the suite.**
  Moderate/minor violations and `incomplete` results are printed to the test
  output for review without blocking. The scan waits for CSS animations to
  finish first, because contrast measured mid-fade is a false reading.
- **Keyboard/behavioral assertions**: skip link focus order, one `h1` inside
  `main` per page, visible focus indicator on header nav, mobile menu
  open/Escape-close, trade-form labels/`autocomplete`/`required`, beer-filter
  `aria-pressed`, reduced-motion behavior of the hero media.
- **Admin assertions**: axe per tab (Beers/Venues/Access — Radix unmounts
  inactive panels), tablist contains only tabs, record-list `aria-current`,
  New-record focus movement, required markers, save/rebuild/invite/resend/
  disable status announcements, named `window.confirm` for destructive
  actions, per-row action accessible names, admin-vs-superadmin Access tab
  visibility, and the admin-list loading announcement.

Run locally:

```bash
npm run test:smoke   # builds, then runs all Playwright specs
npx playwright test smoke-tests/accessibility.spec.ts          # public a11y spec
npx playwright test smoke-tests/admin-accessibility.spec.ts    # admin a11y spec
```

Note: `playwright.config.ts` sets `ADMIN_A11Y_FIXTURE` on the server it
spawns. If you run `npx playwright test` while your own `next start` already
occupies port 3100, Playwright reuses that server and the admin fixture tests
fail — stop your server first or start it with `ADMIN_A11Y_FIXTURE=1`.

## Conventions to preserve

- **Native semantics first.** Real `<button>`/`<a>`/`<label>`/`<main>`/
  `<nav>`/`<details>` elements; ARIA only where HTML lacks the semantics
  (`aria-pressed` on filter toggles, `aria-expanded`/`aria-controls` on the
  mobile menu, `aria-current` on the selected record in admin lists,
  carousel `role`/`aria-roledescription`).
- **Every `<main>` carries `id="main-content" tabIndex={-1}`** — the skip
  link in `app/layout.tsx` targets it and needs `tabIndex={-1}` to move
  focus.
- **Focus must stay visible.** `globals.css` applies a default
  `*:focus-visible` outline in the `--ring` color. Keep it — do not remove
  outlines globally. On dark/photo contexts use `focus-visible:outline-paper`.
- **Every form control needs a programmatic label** (`htmlFor` or wrapped
  `<label>`), a visual required marker when `required`, and sensible
  `autoComplete`. Placeholders are never the only label. Admin form controls
  use `border-ink/50` so the control boundary meets non-text contrast.
- **Repeated row/list actions name their target.** "Promote"/"Disable"/
  "Revoke"/"Resend email" in the admin lists carry `aria-label`s that include
  the affected email — identical button names with no context are a barrier
  for anyone navigating by control. Destructive, irreversible actions use
  `variant="destructive"` styling as well as a confirming `window.confirm`
  that names the target.
- **Dynamic status/error text is announced** via `role="status"` (polite) or
  `role="alert"` (errors) — e.g. the trade form's status region, the admin
  `statusMessage` paragraphs, and the admin-list loading state.
- **Landmark children stay valid.** `role="tablist"` may only contain tabs —
  status badges and other ornaments go beside the `TabsList`, not inside it.
- **Decorative media is hidden from AT** (`alt=""`, `aria-hidden` on the hero
  video). Content images get concise, non-duplicative alt.
- **Nothing auto-plays.** The carousel advances only via its arrow buttons
  (also per `THEME_AND_BRANDING.md`). The hero video is muted, decorative,
  and swaps to a static poster under `prefers-reduced-motion`.
- **`prefers-reduced-motion`** is honored in `globals.css` for the site's
  fade/reveal animations and in JS (`hero-video`, `IntroSection`) for the
  video swap.
- **Multiple `<nav>` landmarks get distinct `aria-label`s** ("Main",
  "Mobile", "Breadcrumb").

## Authenticated admin audit notes

What was reviewed in the authenticated dashboard (all via the fixture route +
manual keyboard pass):

- **Keyboard:** header, tabs (arrow-key navigation), record lists, forms,
  `<details>` disclosure groups, and all row actions are operable; no traps.
  `window.confirm` for destructive/state-changing actions is a native modal —
  keyboard-operable, announced, and focus-restoring; kept intentionally.
- **Focus:** "New beer/venue record" moves focus to the Name field; save and
  action results keep focus on the invoking control and announce via the
  status region.
- **Status messaging:** a single `role="status"` region carries all admin
  results (saves, rebuild, invites, resends, updates, failures). Errors are
  announced politely rather than interrupting — a deliberate choice to avoid
  a chatty admin UI.
- **Known minor:** a focused button that becomes `disabled` mid-action (e.g.
  the rebuild trigger) loses focus to `<body>` — browser behavior; the result
  is still announced.

## Known residual items

- axe reports `color-contrast` as **incomplete** (needs manual review) for
  hero text overlaid on photo/video — backgrounds can't be computed
  programmatically. **Manually reviewed against the rendered homepage** (dark
  `bg-ink/60` overlay, paper-white heading/body text, solid primary CTA,
  bordered secondary CTAs): clearly readable; recorded as a known automation
  limitation, not a WCAG failure. See #51.
- No screen-reader run was performed as part of the audit; behavior is
  asserted via roles/names/focus in Playwright instead.
