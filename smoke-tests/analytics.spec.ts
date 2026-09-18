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

test("test build serves no GTM or legacy gtag bootstrap", async ({ page }) => {
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
