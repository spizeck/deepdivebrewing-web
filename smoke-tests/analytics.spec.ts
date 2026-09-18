import { test, expect } from "./fixtures";

// Analytics-quality checks for the production build. Marketing analytics is
// delivered via Google Tag Manager → GA4; GTM itself loads only in Vercel
// production builds with a configured container ID, so `next start` under
// test serves no GTM bootstrap at all — the app's dataLayer pushes are
// observed directly on window.dataLayer. No test ever contacts Google.

type DataLayerEntry = Record<string, unknown>;

const getDataLayer = async (
  page: import("playwright").Page
): Promise<DataLayerEntry[]> =>
  page.evaluate(
    () =>
      (window as unknown as { dataLayer?: DataLayerEntry[] }).dataLayer ?? []
  );

const events = (entries: DataLayerEntry[], name?: string) =>
  entries.filter((e) => name === undefined || e.event === name);

// Poll until `window.dataLayer` contains `count` entries named `name` —
// pushes happen in effects after hydration/navigation, never synchronously.
async function waitForEvents(
  page: import("playwright").Page,
  name: string,
  count: number
) {
  await expect
    .poll(async () => events(await getDataLayer(page), name).length)
    .toBe(count);
  return events(await getDataLayer(page), name);
}

test("test build serves no GTM, gtag, or consent-default bootstrap", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.locator('script[src*="googletagmanager.com"]')
  ).toHaveCount(0);
  await expect(page.locator('script[src*="/gtag/"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => typeof (window as unknown as { gtag?: unknown }).gtag
    )
  ).toBe("undefined");
  // Consent Mode defaults are emitted only by the production GTM init
  // script — none here. (The bundled consent manager may still queue a
  // `consent` `update` reflecting the fixture's seeded choice; that is a
  // client-side state command, not analytics delivery — see consent.spec.ts.)
  expect(
    (await getDataLayer(page)).some(
      (e) => e[0] === "consent" && e[1] === "default"
    )
  ).toBe(false);
});

test("the app owns page views: one on landing, exactly one per SPA navigation", async ({
  page,
}) => {
  await page.goto("/");
  // The application (not a gtag config or GTM automatic tag) pushes the
  // initial page_view — ownership is unambiguous.
  const initial = await waitForEvents(page, "page_view", 1);
  expect(initial[0]).toMatchObject({ page_path: "/" });

  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Beers" }).click();
  await page.waitForURL("**/beers");
  let views = await waitForEvents(page, "page_view", 2);
  expect(views[1]).toMatchObject({ page_path: "/beers" });

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "About" })
    .click();
  await page.waitForURL("**/about");
  views = await waitForEvents(page, "page_view", 3);
  expect(views[2]).toMatchObject({ page_path: "/about" });
});

test("/admin produces no marketing analytics events", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("main")).toBeVisible();
  // Push-time pathname gating means dataLayer is never even created here.
  expect(await getDataLayer(page)).toHaveLength(0);
});

test("/admin-fixture produces no marketing analytics events", async ({
  page,
}) => {
  const response = await page.goto("/admin-fixture");
  test.skip(
    response?.status() === 404,
    "fixture route requires ADMIN_A11Y_FIXTURE=1 (Playwright webServer sets it)"
  );
  await expect(page.getByRole("main")).toBeVisible();
  expect(await getDataLayer(page)).toHaveLength(0);
});

// Transition coverage: the root layout persists across App Router client
// navigations, so a document that loaded GTM on a public page would keep the
// container active after a client-side entry into /admin* (returning null
// from GtmBootstrap cannot unload it). AdminAnalyticsGuard must turn that
// entry into a full document navigation, leaving a fresh document with no
// container. `history.pushState` below performs a same-document transition
// to /admin inside THIS document — the same in-document state any SPA
// navigation into /admin* produces — without relying on the app exposing a
// link that gets there. The current entry's router state is reused so
// Next.js treats the entry as known and does not race the guard with its
// own fallback navigation.
const enterAdminInSameDocument = (
  page: import("playwright").Page,
  target: string
) =>
  page.evaluate(
    (dest) => history.pushState(history.state, "", dest),
    target
  );

const simulateLoadedContainer = (page: import("playwright").Page) =>
  page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__guardTestDocument = "gtm-carrying";
    w.dataLayer = [{ "gtm.start": 1, event: "gtm.js" }];
    w.google_tag_manager = { containerId: "GTM-TEST" };
  });

// Evaluating while the document unloads throws (context destroyed) — treat
// that as "still navigating" so polls survive the reload boundary.
const documentMarker = (page: import("playwright").Page) =>
  page
    .evaluate(
      () => (window as unknown as Record<string, unknown>).__guardTestDocument
    )
    .catch(() => "navigating");

test("client-side transition into /admin forces a fresh document with no marketing container", async ({
  page,
}) => {
  await page.goto("/");
  await simulateLoadedContainer(page);

  await enterAdminInSameDocument(page, "/admin");

  // The guard forced a document load: this document's marker and container
  // are gone, and the fresh admin document is clean.
  await expect.poll(async () => documentMarker(page)).toBeUndefined();
  expect(page.url()).toMatch(/\/admin$/);
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).google_tag_manager
    )
  ).toBeUndefined();
  expect(await getDataLayer(page)).toHaveLength(0);
});

test("client-side transition into /admin-fixture also forces a fresh document", async ({
  page,
}) => {
  await page.goto("/");
  await simulateLoadedContainer(page);

  await enterAdminInSameDocument(page, "/admin-fixture");

  // The reload boundary applies to the whole /admin* prefix regardless of
  // whether the fixture route exists in this environment — the document
  // that carried the container is gone either way.
  await expect.poll(async () => documentMarker(page)).toBeUndefined();
  expect(page.url()).toMatch(/\/admin-fixture$/);
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).google_tag_manager
    )
  ).toBeUndefined();
});

test("transition into /admin without a marketing container does not reload", async ({
  page,
}) => {
  await page.goto("/");
  // The app's own page_view push creates a dataLayer without a container —
  // that alone must not trigger the guard (it would reload-loop).
  await waitForEvents(page, "page_view", 1);
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__guardTestDocument =
      "clean";
  });

  await enterAdminInSameDocument(page, "/admin");
  await page.waitForURL("**/admin");

  // Same document survived — no container, so no reload happened.
  await expect
    .poll(async () => documentMarker(page), { timeout: 3000 })
    .toBe("clean");
});

test("tracked CTA enters dataLayer exactly once with expected params", async ({
  page,
}) => {
  await page.goto("/");

  // Clicking a tracked link also SPA-navigates → one click event + one
  // page_view; the click event itself must fire exactly once. The hero CTA
  // is selected by its data attributes because an untracked "Where to Buy"
  // link also exists in the header nav.
  await page
    .locator(
      'a[data-analytics-event="where_to_buy_click"][data-analytics-cta-location="homepage_hero"]'
    )
    .click();
  await page.waitForURL("**/where-to-buy");

  const clicks = await waitForEvents(page, "where_to_buy_click", 1);
  expect(clicks[0]).toMatchObject({
    event_category: "conversion",
    cta_location: "homepage_hero",
  });
  await waitForEvents(page, "page_view", 2);
});

test("beer filter fires beer_filter once with the selected value", async ({
  page,
}) => {
  await page.goto("/beers");

  await page.getByRole("button", { name: "Seasonal" }).click();
  const filters = await waitForEvents(page, "beer_filter", 1);
  expect(filters[0]).toMatchObject({
    filter: "seasonal",
    cta_location: "beers_page",
  });
});

test("email link on /contact fires email_click", async ({ page }) => {
  await page.goto("/contact");

  // mailto: has no handler in headless Chromium — the click may attempt
  // navigation; the delegated listener records the event regardless.
  await page
    .getByRole("link", { name: "info@deepdivebrewing.com" })
    .click()
    .catch(() => {});
  const emails = await waitForEvents(page, "email_click", 1);
  expect(emails[0]).toMatchObject({
    event_category: "contact",
    cta_location: "contact_page",
  });
});

test("trade inquiry success fires only after a successful server response", async ({
  page,
}) => {
  await page.route("**/api/trade-inquiry", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    })
  );
  await page.goto("/trade");

  await page.getByLabel(/Business Name/).fill("Audit Test Co");
  await page.getByLabel(/Contact Name/).fill("Test Person");
  await page.getByLabel(/Email/).fill("audit-pii-check@example.com");
  await page.getByLabel(/Venue Type/).selectOption("bar");
  await page.getByRole("button", { name: "Submit Inquiry" }).click();

  await expect(page.getByText(/inquiry/i).first()).toBeVisible();
  await waitForEvents(page, "trade_form_start", 1);
  await waitForEvents(page, "trade_form_success", 1);
  expect(events(await getDataLayer(page), "trade_form_error")).toHaveLength(0);
});

test("trade inquiry failure does not fire success and sends no form PII", async ({
  page,
}) => {
  // Rejected inquiry without an HTTP error status — the shared fixture's
  // runtime guard treats same-origin 4xx responses as failures, and the
  // form's `res.ok || data.ok` check exercises the same error path either way.
  await page.route("**/api/trade-inquiry", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Validation failed" }),
    })
  );
  await page.goto("/trade");

  await page.getByLabel(/Business Name/).fill("Audit Test Co");
  await page.getByLabel(/Contact Name/).fill("Test Person");
  await page.getByLabel(/Email/).fill("audit-pii-check@example.com");
  await page.getByLabel(/Venue Type/).selectOption("bar");
  await page.getByLabel(/Message/).fill("secret business details here");
  await page.getByRole("button", { name: "Submit Inquiry" }).click();

  await expect(page.getByRole("status").first()).toBeVisible();
  await waitForEvents(page, "trade_form_error", 1);
  expect(events(await getDataLayer(page), "trade_form_success")).toHaveLength(
    0
  );

  // No analytics payload may contain user-entered data.
  const serialized = JSON.stringify(await getDataLayer(page));
  for (const pii of [
    "audit-pii-check@example.com",
    "Audit Test Co",
    "Test Person",
    "secret business details",
  ]) {
    expect(serialized).not.toContain(pii);
  }
});

test("tracked links still navigate when the dataLayer queue is hostile", async ({
  page,
}) => {
  // Simulate a GTM-free environment where even the queue is broken —
  // analytics must never break a link.
  await page.addInitScript(() => {
    const w = window as unknown as { dataLayer: { push: () => void } };
    w.dataLayer = {
      push: () => {
        throw new Error("blocked");
      },
    };
  });
  await page.goto("/");
  await page
    .locator('a[data-analytics-event="where_to_buy_click"]')
    .first()
    .click();
  await page.waitForURL("**/where-to-buy");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
