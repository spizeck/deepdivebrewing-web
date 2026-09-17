# Accessibility

Current-state accessibility reference for the Deep Dive Brewing Co website,
plus the conventions and automated checks that keep it there. Reference point
is WCAG 2.2 AA — this is a practical baseline, not a certification.

## What is covered

| Surface | Coverage |
| --- | --- |
| `/`, `/beers`, `/about`, `/trade`, `/contact`, `/where-to-buy`, `/admin`, `/beers/[slug]` (404 path) | axe scan (serious/critical block) + keyboard checks |
| Authenticated admin dashboard | Not covered by automated checks — no credential-free way to reach it. Its forms use implicit `<label>` wrapping and shared `ui/` primitives; audit by hand when changing it. |

## Automated checks

`smoke-tests/accessibility.spec.ts` runs in the same Playwright suite as the
smoke tests (`npx playwright test`, executed by CI after `npm run build`):

- **axe-core** (`@axe-core/playwright`) scans the routes above with WCAG
  2.0/2.1/2.2 A+AA tags. **Serious and critical violations fail the suite.**
  Moderate/minor violations and `incomplete` results are printed to the test
  output for review without blocking. The scan waits for CSS animations to
  finish first, because contrast measured mid-fade is a false reading.
- **Keyboard/behavioral assertions**: skip link focus order, one `h1` inside
  `main` per page, visible focus indicator on header nav, mobile menu
  open/Escape-close, trade-form labels/`autocomplete`/`required`, beer-filter
  `aria-pressed`, and reduced-motion behavior of the hero media.

Run locally:

```bash
npm run test:smoke   # builds, then runs all Playwright specs
npx playwright test smoke-tests/accessibility.spec.ts   # a11y spec only
```

## Conventions to preserve

- **Native semantics first.** Real `<button>`/`<a>`/`<label>`/`<main>`/
  `<nav>`/`<details>` elements; ARIA only where HTML lacks the semantics
  (`aria-pressed` on filter toggles, `aria-expanded`/`aria-controls` on the
  mobile menu, carousel `role`/`aria-roledescription`).
- **Every `<main>` carries `id="main-content" tabIndex={-1}`** — the skip
  link in `app/layout.tsx` targets it and needs `tabIndex={-1}` to move
  focus.
- **Focus must stay visible.** `globals.css` applies a default
  `*:focus-visible` outline in the `--ring` color. Keep it — do not remove
  outlines globally. On dark/photo contexts use `focus-visible:outline-paper`.
- **Every form control needs a programmatic label** (`htmlFor` or wrapped
  `<label>`), a visual required marker when `required`, and sensible
  `autoComplete`. Placeholders are never the only label.
- **Dynamic status/error text is announced** via `role="status"` (polite) or
  `role="alert"` (errors) — e.g. the trade form's status region and the admin
  `statusMessage` paragraphs.
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

## Known residual items

- axe reports `color-contrast` as **incomplete** (needs manual review) for
  hero text overlaid on photo/video — backgrounds can't be computed
  programmatically. Verified manually: paper text on `bg-ink/60` over imagery.
- No screen-reader run was performed as part of the audit; behavior is
  asserted via roles/names/focus in Playwright instead.
- The authenticated admin UI is not covered by automated checks (see table).
