import { test, expect } from "./fixtures";

// Technical-SEO checks for the production build: metadata, canonicals,
// robots directives, sitemap coverage, and structured data. All assertions
// hold whether or not Firestore data is available (in CI the sitemap simply
// contains no beer-detail URLs).

const CANONICAL_ORIGIN = "https://deepdivebrewing.com";

const INDEXABLE_ROUTES = [
  "/",
  "/beers",
  "/about",
  "/contact",
  "/where-to-buy",
  "/trade",
  "/privacy",
  "/terms",
] as const;

test("indexable pages have unique titles, descriptions, canonicals, and one h1", async ({
  page,
}) => {
  const titles = new Set<string>();
  for (const route of INDEXABLE_ROUTES) {
    await page.goto(route);

    const title = await page.title();
    expect(title, `${route} title`).toBeTruthy();
    titles.add(title);

    const description = await page
      .locator('meta[name="description"]')
      .getAttribute("content");
    expect(description, `${route} description`).toBeTruthy();

    const canonical = await page
      .locator('link[rel="canonical"]')
      .getAttribute("href");
    expect(
      canonical,
      `${route} canonical`
    ).toBeTruthy();
    const canonicalUrl = new URL(canonical!);
    expect(canonicalUrl.origin).toBe(CANONICAL_ORIGIN);
    expect(canonicalUrl.pathname).toBe(route);

    await expect(page.locator("h1")).toHaveCount(1);
  }
  expect(
    titles.size,
    `titles must be unique across indexable routes`
  ).toBe(INDEXABLE_ROUTES.length);
});

test("key pages expose Open Graph and Twitter metadata on the canonical host", async ({
  page,
}) => {
  for (const route of ["/", "/beers", "/where-to-buy", "/trade"]) {
    await page.goto(route);

    await expect(
      page.locator('meta[property="og:title"]')
    ).toHaveAttribute("content", /.+/);
    const ogUrl = await page
      .locator('meta[property="og:url"]')
      .getAttribute("content");
    expect(ogUrl, `${route} og:url`).toBeTruthy();
    expect(new URL(ogUrl!).origin).toBe(CANONICAL_ORIGIN);
    expect(new URL(ogUrl!).pathname).toBe(route);
    await expect(
      page.locator('meta[property="og:image"]')
    ).toHaveAttribute("content", /.+/);
    await expect(
      page.locator('meta[name="twitter:card"]')
    ).toHaveAttribute("content", /.+/);
  }
});

test("private and placeholder routes are marked noindex", async ({ page }) => {
  // /admin-fixture and /where-to-buy-fixture render only under their
  // server-side test flags (enabled by the smoke webServer); either way they
  // must never be indexable.
  for (const route of [
    "/admin",
    "/admin-fixture",
    "/where-to-buy-fixture",
    "/trade/login",
    "/trade/order",
    "/trade/orders",
    "/beers/definitely-not-a-real-beer",
  ]) {
    await page.goto(route);
    // Some routes emit more than one robots tag (page-level + boundary-level
    // metadata); every one of them must carry noindex.
    const contents = await page
      .locator('meta[name="robots"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("content") ?? ""));
    expect(contents.length, `${route} robots meta`).toBeGreaterThan(0);
    for (const content of contents) {
      expect(content, `${route} robots meta`).toContain("noindex");
    }
  }
});

test("robots.txt disallows private surfaces and advertises the canonical sitemap", async ({
  request,
}) => {
  const response = await request.get("/robots.txt");
  expect(response.ok()).toBeTruthy();
  const body = await response.text();
  expect(body).toContain(`Sitemap: ${CANONICAL_ORIGIN}/sitemap.xml`);
  expect(body).toContain(`Host: ${CANONICAL_ORIGIN}`);
  for (const path of [
    "/admin",
    "/admin-fixture",
    "/where-to-buy-fixture",
    "/trade/login",
    "/api/",
  ]) {
    expect(body).toContain(`Disallow: ${path}`);
  }
});

test("sitemap.xml covers public routes only on the canonical host", async ({
  request,
}) => {
  const response = await request.get("/sitemap.xml");
  expect(response.ok()).toBeTruthy();
  const body = await response.text();
  for (const route of INDEXABLE_ROUTES) {
    expect(body).toContain(`${CANONICAL_ORIGIN}${route}`);
  }
  for (const forbidden of [
    "/admin",
    "/admin-fixture",
    "/where-to-buy-fixture",
    "/trade/login",
    "/trade/order",
    "/trade/orders",
    "/api/",
  ]) {
    expect(body).not.toContain(forbidden);
  }
  // Beer detail URLs appear only when beer data was available at build time;
  // if present they must also use the canonical host.
  for (const match of body.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    expect(new URL(match[1]).origin).toBe(CANONICAL_ORIGIN);
  }
});

test("structured data blocks parse and use accurate types", async ({
  page,
  request,
}) => {
  const jsonLdTypes = async (route: string) => {
    await page.goto(route);
    const blocks = await page
      .locator('script[type="application/ld+json"]')
      .allTextContents();
    expect(blocks.length, `${route} JSON-LD blocks`).toBeGreaterThan(0);
    return blocks.map((raw) => {
      const parsed = JSON.parse(raw) as { "@type"?: string };
      return parsed["@type"];
    });
  };

  expect(await jsonLdTypes("/")).toContain("Brewery");
  expect(await jsonLdTypes("/where-to-buy")).toEqual(
    expect.arrayContaining(["Brewery", "FAQPage"])
  );
  expect(await jsonLdTypes("/contact")).toContain("Brewery");
  expect(await jsonLdTypes("/trade")).toContain("Brewery");

  // Beer detail pages render only when Firestore data is available; when one
  // exists, it must emit BreadcrumbList and never a Product candidate.
  const sitemap = await (await request.get("/sitemap.xml")).text();
  const beerUrl = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => new URL(m[1]).pathname)
    .find((path) => /^\/beers\/[^/]+$/.test(path));
  if (beerUrl) {
    expect(await jsonLdTypes(beerUrl)).toEqual(["BreadcrumbList"]);
  }
});

test("every Brewery-schema page emits the identical canonical entity", async ({
  page,
}) => {
  // Issue #107: one Brewery entity (`@id: <site>/#brewery`) is shared by all
  // four pages via buildBreweryJsonLd — field sets must never diverge again.
  const breweryFor = async (route: string) => {
    await page.goto(route);
    const blocks = await page
      .locator('script[type="application/ld+json"]')
      .allTextContents();
    const brewery = blocks
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((node) => node["@type"] === "Brewery");
    expect(brewery, `${route} Brewery entity`).toBeTruthy();
    return brewery!;
  };

  const routes = ["/", "/contact", "/trade", "/where-to-buy"];
  const entities: Record<string, unknown>[] = [];
  for (const route of routes) {
    entities.push(await breweryFor(route));
  }
  for (const [i, entity] of entities.entries()) {
    expect(entity, `${routes[i]} Brewery entity`).toEqual(entities[0]);
  }

  const brewery = entities[0];
  expect(brewery["@id"]).toBe(`${CANONICAL_ORIGIN}/#brewery`);
  for (const field of [
    "name",
    "legalName",
    "url",
    "image",
    "email",
    "telephone",
    "address",
    "areaServed",
    "openingHoursSpecification",
    "description",
    "sameAs",
  ]) {
    expect(brewery[field], `Brewery.${field}`).toBeTruthy();
  }
});
