import { test, expect } from "./fixtures";

// Analytics-quality checks for the production build. GA4 is gated to Vercel
// production builds (VERCEL_ENV=production), so `next start` under test
// serves no gtag bootstrap at all — these tests install a mock `window.gtag`
// that records calls. No test ever contacts Google.

type GtagCall = unknown[];

const installMockGtag = async (page: import("playwright").Page) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __gtagCalls: unknown[][];
      gtag: (...args: unknown[]) => void;
    };
    w.__gtagCalls = [];
    w.gtag = (...args: unknown[]) => {
      w.__gtagCalls.push(args);
    };
  });
};

const getCalls = async (
  page: import("playwright").Page
): Promise<GtagCall[]> =>
  page.evaluate(
    () => (window as unknown as { __gtagCalls: GtagCall[] }).__gtagCalls
  );

const eventCalls = (calls: GtagCall[], name?: string) =>
  calls.filter(
    (c) => c[0] === "event" && (name === undefined || c[1] === name)
  );

test("SPA navigations emit exactly one page_view each; landing emits none", async ({
  page,
}) => {
  await installMockGtag(page);
  await page.goto("/");
  // No gtag bootstrap in the test build and the tracker skips first render —
  // the landing page_view is the production gtag config's job, not ours.
  expect(await getCalls(page)).toHaveLength(0);

  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Beers" }).click();
  await page.waitForURL("**/beers");
  let calls = await getCalls(page);
  expect(eventCalls(calls, "page_view")).toEqual([
    ["event", "page_view", { page_path: "/beers" }],
  ]);

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "About" }).click();
  await page.waitForURL("**/about");
  calls = await getCalls(page);
  expect(eventCalls(calls, "page_view")).toEqual([
    ["event", "page_view", { page_path: "/beers" }],
    ["event", "page_view", { page_path: "/about" }],
  ]);
});

test("tracked CTA fires exactly once with expected params", async ({
  page,
}) => {
  await installMockGtag(page);
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

  const calls = await getCalls(page);
  const clicks = eventCalls(calls, "where_to_buy_click");
  expect(clicks).toHaveLength(1);
  expect(clicks[0][2]).toMatchObject({
    event_category: "conversion",
    cta_location: "homepage_hero",
  });
  expect(eventCalls(calls, "page_view")).toHaveLength(1);
});

test("beer filter fires beer_filter once with the selected value", async ({
  page,
}) => {
  await installMockGtag(page);
  await page.goto("/beers");

  await page.getByRole("button", { name: "Seasonal" }).click();
  const calls = await getCalls(page);
  const filters = eventCalls(calls, "beer_filter");
  expect(filters).toHaveLength(1);
  expect(filters[0][2]).toMatchObject({
    filter: "seasonal",
    cta_location: "beers_page",
  });
});

test("email link on /contact fires email_click", async ({ page }) => {
  await installMockGtag(page);
  await page.goto("/contact");

  // mailto: has no handler in headless Chromium — the click may attempt
  // navigation; the delegated listener records the event regardless.
  await page
    .getByRole("link", { name: "info@deepdivebrewing.com" })
    .click()
    .catch(() => {});
  const calls = await getCalls(page);
  const emails = eventCalls(calls, "email_click");
  expect(emails).toHaveLength(1);
  expect(emails[0][2]).toMatchObject({
    event_category: "contact",
    cta_location: "contact_page",
  });
});

test("trade inquiry success fires only after a successful server response", async ({
  page,
}) => {
  await installMockGtag(page);
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
  const calls = await getCalls(page);
  expect(eventCalls(calls, "trade_form_start")).toHaveLength(1);
  expect(eventCalls(calls, "trade_form_success")).toHaveLength(1);
  expect(eventCalls(calls, "trade_form_error")).toHaveLength(0);
});

test("trade inquiry failure does not fire success and sends no form PII", async ({
  page,
}) => {
  await installMockGtag(page);
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
  const calls = await getCalls(page);
  expect(eventCalls(calls, "trade_form_success")).toHaveLength(0);
  expect(eventCalls(calls, "trade_form_error")).toHaveLength(1);

  // No analytics payload may contain user-entered data.
  const serialized = JSON.stringify(calls);
  for (const pii of [
    "audit-pii-check@example.com",
    "Audit Test Co",
    "Test Person",
    "secret business details",
  ]) {
    expect(serialized).not.toContain(pii);
  }
});

test("tracked links still navigate when gtag is entirely unavailable", async ({
  page,
}) => {
  // No mock installed — window.gtag is undefined.
  await page.goto("/");
  await page
    .locator('a[data-analytics-event="where_to_buy_click"]')
    .first()
    .click();
  await page.waitForURL("**/where-to-buy");
  await expect(
    page.getByRole("heading", { level: 1 })
  ).toBeVisible();
});
