import { test, expect } from "./fixtures";

// Filtering behavior for /where-to-buy, exercised against the deterministic
// /where-to-buy-fixture route (enabled only by the Playwright webServer env).
// The consent fixture seeds a declined-analytics choice, so every test here
// also proves filtering works with analytics consent declined.
//
// Fixture data (lib/where-to-buy-fixture.ts):
//   Fixture Tavern      Fort Bay, Saba                  tap: pilsner        can: ipa
//   Fixture Bottle Shop Windwardside, Saba              can: ipa
//   Fixture Harbor Bar  SXM                             tap: pilsner + ipa
//   Fixture Quiet Cafe  Windwardside / The Bottom, Saba carries nothing
//   Flat Point Amber is a public beer carried by no venue — never an option.
// The three Saba venues deliberately use distinct "<locality>, Saba"
// locationNames so this suite covers the island-grouping regression from
// issue #116 (localities fragmenting into per-locality island groups).

const ROUTE = "/where-to-buy-fixture";

const venueNames = async (page: import("playwright").Page) =>
  page.locator("main h3").allTextContents();

const beerSelect = (page: import("playwright").Page) =>
  page.getByLabel("Beer", { exact: true });

const islandSelect = (page: import("playwright").Page) =>
  page.getByLabel("Island", { exact: true });

const formatButton = (page: import("playwright").Page, name: string) =>
  page.getByRole("button", { name, exact: true });

const statusText = (page: import("playwright").Page) =>
  page.locator("main").getByRole("status");

test.beforeEach(async ({ page }) => {
  const response = await page.goto(ROUTE);
  test.skip(
    response?.status() === 404,
    "fixture route disabled (WHERE_TO_BUY_FIXTURE env not set)"
  );
});

test("renders filters and all venues unfiltered", async ({ page }) => {
  await expect(beerSelect(page)).toBeVisible();
  // Only beers carried by a listed venue are options — Flat Point Amber is
  // public but unlisted.
  await expect(beerSelect(page).locator("option")).toHaveText([
    "Any beer",
    "Saba Suds Pilsner",
    "Fort Bay IPA",
  ]);
  await expect(formatButton(page, "On Tap")).toBeVisible();
  await expect(formatButton(page, "In Can")).toBeVisible();
  await expect(islandSelect(page)).toBeVisible();
  // One option per real island — the three Saba localities collapse to a
  // single "Saba" choice (#116).
  await expect(islandSelect(page).locator("option")).toHaveText([
    "All islands",
    "Saba",
    "Sint Maarten / Saint Martin",
  ]);
  // "SXM" is the internal key only — never a customer-facing option (#124).
  await expect(
    islandSelect(page).locator("option", { hasText: "SXM" })
  ).toHaveCount(0);
  await expect(statusText(page)).toHaveText("4 venues shown");
  expect(await venueNames(page)).toEqual([
    "Fixture Tavern",
    "Fixture Bottle Shop",
    "Fixture Quiet Cafe",
    "Fixture Harbor Bar",
  ]);
  // Availability caveat is always present.
  await expect(
    page.getByText("Availability can change", { exact: false })
  ).toBeVisible();
});

test("beer filter narrows to venues carrying that beer", async ({ page }) => {
  await beerSelect(page).selectOption("saba-suds-pilsner");
  await expect(statusText(page)).toHaveText("2 venues shown");
  expect(await venueNames(page)).toEqual([
    "Fixture Tavern",
    "Fixture Harbor Bar",
  ]);
  await expect(page).toHaveURL(/beer=saba-suds-pilsner/);
});

test("format chips filter by On Tap / In Can", async ({ page }) => {
  await formatButton(page, "In Can").click();
  await expect(statusText(page)).toHaveText("2 venues shown");
  expect(await venueNames(page)).toEqual([
    "Fixture Tavern",
    "Fixture Bottle Shop",
  ]);
  await expect(formatButton(page, "In Can")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page).toHaveURL(/format=can/);

  await formatButton(page, "On Tap").click();
  await expect(statusText(page)).toHaveText("2 venues shown");
  expect(await venueNames(page)).toEqual([
    "Fixture Tavern",
    "Fixture Harbor Bar",
  ]);

  await formatButton(page, "All").click();
  await expect(statusText(page)).toHaveText("4 venues shown");
});

test("beer + format means that beer in that format", async ({ page }) => {
  await beerSelect(page).selectOption("fort-bay-ipa");
  await formatButton(page, "On Tap").click();
  await expect(statusText(page)).toHaveText("1 venue shown");
  expect(await venueNames(page)).toEqual(["Fixture Harbor Bar"]);
});

test("island filter matches the canonical island", async ({ page }) => {
  await islandSelect(page).selectOption("sxm");
  await expect(statusText(page)).toHaveText("1 venue shown");
  expect(await venueNames(page)).toEqual(["Fixture Harbor Bar"]);
  await expect(page).toHaveURL(/island=sxm/);
});

test("Saba localities render under one Saba group and one filter option", async ({
  page,
}) => {
  // Issue #116 regression: "<locality>, Saba" locationNames must not
  // fragment into per-locality island groups or headings like
  // "Fort bay, saba".
  await expect(page.locator("main h2")).toHaveText([
    "Saba",
    "Sint Maarten / Saint Martin",
  ]);
  await expect(
    page.getByRole("heading", { name: "Fort bay, saba" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Windwardside, saba" })
  ).toHaveCount(0);

  // All three Saba venues sit inside the single Saba section, and each
  // card still shows its raw locality text.
  const sabaSection = page.locator("main section").filter({
    has: page.getByRole("heading", { name: "Saba", level: 2, exact: true }),
  });
  await expect(sabaSection.locator("h3")).toHaveText([
    "Fixture Tavern",
    "Fixture Bottle Shop",
    "Fixture Quiet Cafe",
  ]);
  await expect(
    sabaSection.getByText("Fort Bay, Saba", { exact: true })
  ).toBeVisible();
  await expect(
    sabaSection.getByText("Windwardside, Saba", { exact: true })
  ).toBeVisible();
  await expect(
    sabaSection.getByText("Windwardside / The Bottom, Saba", {
      exact: true,
    })
  ).toBeVisible();

  // The Saba option returns every Saba venue and excludes other islands.
  await islandSelect(page).selectOption("saba");
  await expect(statusText(page)).toHaveText("3 venues shown");
  expect(await venueNames(page)).toEqual([
    "Fixture Tavern",
    "Fixture Bottle Shop",
    "Fixture Quiet Cafe",
  ]);
});

test("impossible combination shows the empty state, clear restores all", async ({
  page,
}) => {
  await beerSelect(page).selectOption("saba-suds-pilsner");
  await formatButton(page, "In Can").click();
  await expect(statusText(page)).toHaveText("0 venues shown");
  expect(await venueNames(page)).toHaveLength(0);
  await expect(
    page.getByText("No venues match those filters", { exact: false })
  ).toBeVisible();

  await page
    .getByRole("button", { name: "Clear filters" })
    .first()
    .click();
  await expect(statusText(page)).toHaveText("4 venues shown");
  await expect(page).not.toHaveURL(/\?/);
});

test("shared filtered URL restores the selection on load", async ({
  page,
}) => {
  await page.goto(`${ROUTE}?beer=fort-bay-ipa&format=can&island=saba`);
  await expect(statusText(page)).toHaveText("2 venues shown");
  expect(await venueNames(page)).toEqual([
    "Fixture Tavern",
    "Fixture Bottle Shop",
  ]);
  await expect(beerSelect(page)).toHaveValue("fort-bay-ipa");
  await expect(formatButton(page, "In Can")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(islandSelect(page)).toHaveValue("saba");
});

test("stale or invalid URL params fall back to unfiltered", async ({
  page,
}) => {
  await page.goto(`${ROUTE}?beer=deleted-beer&format=keg&island=aruba`);
  await expect(statusText(page)).toHaveText("4 venues shown");
  await expect(beerSelect(page)).toHaveValue("");
  await expect(formatButton(page, "All")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

test("back/forward navigates between filter states", async ({ page }) => {
  await beerSelect(page).selectOption("saba-suds-pilsner");
  await expect(statusText(page)).toHaveText("2 venues shown");

  await page.goBack();
  await expect(statusText(page)).toHaveText("4 venues shown");
  await expect(beerSelect(page)).toHaveValue("");

  await page.goForward();
  await expect(statusText(page)).toHaveText("2 venues shown");
});

test("filter changes emit beer_filter events with facet labels", async ({
  page,
}) => {
  const dataLayer = () =>
    page.evaluate(
      () =>
        (window as unknown as { dataLayer?: Record<string, unknown>[] })
          .dataLayer ?? []
    );
  const filterEvents = async () =>
    (await dataLayer()).filter((e) => e.event === "beer_filter");

  await beerSelect(page).selectOption("fort-bay-ipa");
  await formatButton(page, "In Can").click();
  await expect.poll(async () => (await filterEvents()).length).toBe(2);

  const [beer, format] = await filterEvents();
  expect(beer).toMatchObject({
    event_label: "beer",
    filter: "fort-bay-ipa",
    beer_slug: "fort-bay-ipa",
    cta_location: "where_to_buy_page",
  });
  expect(format).toMatchObject({
    event_label: "format",
    filter: "can",
    cta_location: "where_to_buy_page",
  });
});

test("directions link survives filtering and keeps its tracking attrs", async ({
  page,
}) => {
  const directions = page.getByRole("link", {
    name: "Directions to Fixture Tavern",
  });
  await expect(directions).toBeVisible();
  await expect(directions).toHaveAttribute(
    "data-analytics-event",
    "directions_click"
  );
  await expect(directions).toHaveAttribute("data-analytics-venue-slug", "fixture-tavern");

  // Still reachable after filtering down to the Tavern.
  await beerSelect(page).selectOption("fort-bay-ipa");
  await formatButton(page, "In Can").click();
  await expect(directions).toBeVisible();
});

test("no horizontal overflow at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.reload();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Controls stay usable — select a beer and confirm filtering works.
  await beerSelect(page).selectOption("fort-bay-ipa");
  await expect(statusText(page)).toHaveText("3 venues shown");
});
