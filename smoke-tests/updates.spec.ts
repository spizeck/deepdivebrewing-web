import { test, expect } from "./fixtures";

// /updates (Issue #194) — archive, detail, fixture-layout, and SEO checks
// against the production build. The seeded post is always present, so the
// real archive covers the single-update state; the env-gated fixture route
// covers the empty and multi-post states it cannot reach.

test("updates archive leads with the newest published update", async ({
  page,
}) => {
  await page.goto("/updates");
  await expect(page.locator("h1")).toHaveText("Updates");
  const feature = page.locator("article h2 a");
  await expect(feature).toHaveText("Brew Day at Fort Bay");
  await expect(feature).toHaveAttribute(
    "href",
    "/updates/brew-day-at-fort-bay"
  );
  await expect(page.locator("article time")).toHaveAttribute(
    "datetime",
    "2026-10-06"
  );
});

test("update detail renders date, canonical, article OG, and BlogPosting", async ({
  page,
}) => {
  const response = await page.goto("/updates/brew-day-at-fort-bay");
  expect(response?.status()).toBe(200);

  await expect(page.locator("h1")).toHaveText("Brew Day at Fort Bay");
  await expect(
    page.locator("time[datetime='2026-10-06']")
  ).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://deepdivebrewing.com/updates/brew-day-at-fort-bay"
  );
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute(
    "content",
    "article"
  );
  await expect(
    page.locator('meta[property="article:published_time"]')
  ).toHaveAttribute("content", "2026-10-06");

  const blocks = await page
    .locator('script[type="application/ld+json"]')
    .allTextContents();
  const types = blocks.map(
    (raw) => (JSON.parse(raw) as { "@type"?: string })["@type"]
  );
  expect(types).toContain("BlogPosting");

  // Breadcrumb links back to the archive.
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link")
  ).toHaveAttribute("href", "/updates");
});

test("unknown update slugs serve a noindex 404", async ({ page }) => {
  const response = await page.goto("/updates/definitely-not-a-real-update");
  expect(response?.status()).toBe(404);
  const contents = await page
    .locator('meta[name="robots"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("content") ?? ""));
  for (const content of contents) {
    expect(content).toContain("noindex");
  }
});

test("archive fixture covers empty, single, and multi-post states", async ({
  page,
}) => {
  await page.goto("/updates-fixture?state=empty");
  await expect(page.getByText("Nothing new to report")).toBeVisible();
  expect(await page.locator("main article").count()).toBe(0);

  await page.goto("/updates-fixture?state=single");
  await expect(
    page.getByRole("link", { name: "Fixture Single Update" })
  ).toBeVisible();
  // A lone update renders as the feature — no archive list below it.
  expect(await page.locator("main ol li").count()).toBe(0);

  await page.goto("/updates-fixture");
  await expect(
    page.getByRole("link", { name: "Fixture Newest Update" })
  ).toBeVisible();
  // Feature plus two dated rows.
  expect(await page.locator("main ol li").count()).toBe(2);
});

test("sitemap lists the archive and the published post", async ({
  request,
}) => {
  const response = await request.get("/sitemap.xml");
  const body = await response.text();
  expect(body).toContain("https://deepdivebrewing.com/updates");
  expect(body).toContain(
    "https://deepdivebrewing.com/updates/brew-day-at-fort-bay"
  );
  expect(body).toMatch(/lastmod>2026-10-06/);
});

test("homepage teaser links the latest update and the archive", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Latest from the Brewery" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Brew Day at Fort Bay" })
  ).toHaveAttribute("href", "/updates/brew-day-at-fort-bay");
  await expect(
    page.getByRole("link", { name: "All updates" })
  ).toHaveAttribute("href", "/updates");
});
