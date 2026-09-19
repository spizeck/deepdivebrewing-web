import { test, expect } from "./fixtures";

// Click-to-load boundary for the /contact Google Maps embed (Issue #77).
// The map is a functional embed with its own contextual consent — it is NOT
// part of the Klaro analytics model and must behave identically whether
// analytics consent is granted or denied. The shared fixture seeds a stored
// "declined" choice and aborts cross-origin requests, but request events
// still fire, so we can assert the boundary behaviorally: zero Google
// requests before the visitor clicks, embed requests after.
//
// The iframe is inserted into the DOM on click; its navigation is aborted
// by the fixture (no external contact), which is exactly what we want to
// observe — the element and the request attempt, not Google's response.

const loadMap = (page: import("playwright").Page) =>
  page.getByRole("button", { name: "Load map" });

const getDirections = (page: import("playwright").Page) =>
  page.getByRole("link", { name: "Get directions" });

const mapIframe = (page: import("playwright").Page) =>
  page.locator('iframe[src*="google.com/maps"]');

const googleRequests = (page: import("playwright").Page) => {
  const urls: string[] = [];
  page.on("request", (req) => {
    const { hostname } = new URL(req.url());
    if (
      hostname === "www.google.com" ||
      hostname === "maps.google.com" ||
      hostname.endsWith(".googleapis.com") ||
      hostname.endsWith(".gstatic.com")
    ) {
      urls.push(req.url());
    }
  });
  return urls;
};

type DataLayerEntry = Record<string, unknown> & { 0?: string; 1?: string };

const getDataLayer = async (
  page: import("playwright").Page
): Promise<DataLayerEntry[]> =>
  page.evaluate(
    () =>
      (window as unknown as { dataLayer?: DataLayerEntry[] }).dataLayer ?? []
  );

const consentUpdates = (entries: DataLayerEntry[]) =>
  entries.filter((e) => e[0] === "consent" && e[1] === "update");

const seedAnalyticsConsent = async (
  page: import("playwright").Page,
  granted: boolean
) => {
  const origin = new URL(page.url() || "http://localhost:3100").origin;
  await page.context().addCookies([
    {
      name: "ddb-consent-v1",
      value: encodeURIComponent(
        JSON.stringify({
          "consent-preferences": true,
          "google-analytics": granted,
        })
      ),
      url: origin,
    },
  ]);
};

test("/contact initially renders a placeholder, not the Google Maps iframe", async ({
  page,
}) => {
  await page.goto("/contact");

  // No iframe at all on the page — the embed is not even in the DOM.
  await expect(page.locator("iframe")).toHaveCount(0);

  // The embed URL must not appear in the served HTML/DOM. (The Get
  // directions link is a user-initiated navigation, not an embed, and
  // uses a different URL.)
  const html = await page.content();
  expect(html).not.toContain("output=embed");
  expect(html).not.toContain("google.com/maps?q=");

  // The intentional placeholder offers both actions up front.
  await expect(
    page.getByText("Find us at Fort Bay")
  ).toBeVisible();
  await expect(loadMap(page)).toBeVisible();
  await expect(getDirections(page)).toBeVisible();
});

test("no Google request fires until the visitor clicks Load map", async ({
  page,
}) => {
  const requests = googleRequests(page);
  await page.goto("/contact");
  await expect(loadMap(page)).toBeVisible();

  // Give the page a settle window — if anything were going to contact
  // Google (embed, fonts, tiles), it would have done so by now.
  await page.waitForTimeout(1500);
  expect(requests).toHaveLength(0);

  // Clicking inserts the iframe and the browser immediately navigates it
  // (the fixture then aborts the cross-origin request — observed, not served).
  const iframeRequest = page.waitForRequest((req) =>
    req.url().startsWith("https://www.google.com/maps")
  );
  await loadMap(page).click();
  await iframeRequest;
  expect(requests.length).toBeGreaterThan(0);
});

test("Load map inserts the titled embed; focus does not jump into it", async ({
  page,
}) => {
  await page.goto("/contact");

  const button = loadMap(page);
  await button.focus();
  await page.keyboard.press("Enter");

  const iframe = mapIframe(page);
  await expect(iframe).toHaveCount(1);
  await expect(iframe).toHaveAttribute(
    "title",
    "Deep Dive Brewing Co location"
  );
  await expect(iframe).toHaveAttribute(
    "src",
    "https://www.google.com/maps?q=66+Fort+Bay+Road,+The+Bottom,+Saba&output=embed"
  );

  // The placeholder (and its button) unmounted — focus must fall back to
  // the document, never be pushed into the iframe.
  await expect
    .poll(async () =>
      page.evaluate(() => document.activeElement?.tagName)
    )
    .toBe("BODY");
});

test("loading the map does not change analytics consent state", async ({
  page,
}) => {
  await page.goto("/contact");

  // Seeded "declined" choice: the consent manager publishes its update on
  // load. Record the baseline, then load the map.
  await expect
    .poll(async () => consentUpdates(await getDataLayer(page)).length)
    .toBeGreaterThan(0);
  const baseline = consentUpdates(await getDataLayer(page));

  await loadMap(page).click();
  await expect(mapIframe(page)).toHaveCount(1);

  const after = consentUpdates(await getDataLayer(page));
  expect(after.length).toBe(baseline.length);
  expect(after.at(-1)?.[2]).toMatchObject({ analytics_storage: "denied" });

  // The consent cookie itself is untouched — Maps never reads or writes it.
  const cookie = (await page.context().cookies()).find(
    (c) => c.name === "ddb-consent-v1"
  );
  expect(cookie?.value).toContain("google-analytics%22%3Afalse");
});

test("map loads when analytics consent is accepted", async ({ page }) => {
  await page.goto("/contact");
  await seedAnalyticsConsent(page, true);
  await page.reload();

  // Granted analytics state is republished on load (Klaro chunk resolves
  // asynchronously — poll for it rather than racing the lazy import).
  await expect
    .poll(async () => consentUpdates(await getDataLayer(page)).length)
    .toBeGreaterThan(0);
  expect(consentUpdates(await getDataLayer(page)).at(-1)?.[2]).toMatchObject({
    analytics_storage: "granted",
  });

  await loadMap(page).click();
  await expect(mapIframe(page)).toHaveCount(1);

  // The map interaction adds no consent commands and changes nothing.
  const updates = consentUpdates(await getDataLayer(page));
  expect(updates.at(-1)?.[2]).toMatchObject({
    analytics_storage: "granted",
  });
});

test("Get directions fires directions_click before any map load", async ({
  page,
}) => {
  await page.goto("/contact");
  await expect(mapIframe(page)).toHaveCount(0);

  await getDirections(page).click();
  await expect
    .poll(async () =>
      (await getDataLayer(page)).filter((e) => e.event === "directions_click")
        .length
    )
    .toBe(1);
  const [event] = (await getDataLayer(page)).filter(
    (e) => e.event === "directions_click"
  );
  expect(event).toMatchObject({
    event_category: "conversion",
    event_label: "Directions",
    cta_location: "contact_page",
  });
});

test("map placeholder stays usable at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/contact");

  await expect(loadMap(page)).toBeVisible();
  await expect(getDirections(page)).toBeVisible();
  await loadMap(page).click();
  await expect(mapIframe(page)).toHaveCount(1);
});
