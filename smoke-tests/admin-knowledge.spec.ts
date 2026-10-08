import { test, expect } from "./fixtures";
import { scanAxe, formatBlocking, waitForAnimations } from "./axe-helpers";

// Knowledge Base coverage (#201) via /admin-knowledge-fixture — renders the
// real landing/article/editor/history components against the in-memory
// fixture API (no Firebase). The route only exists when the server was
// started with KNOWLEDGE_FIXTURE=1 (the Playwright webServer sets it).

const FIXTURE = "/admin-knowledge-fixture";

test.beforeAll(async ({ request }) => {
  const res = await request.get(FIXTURE);
  if (res.status() === 404) {
    throw new Error(
      `${FIXTURE} returned 404 — the suite requires the Playwright-managed ` +
        "server (started with KNOWLEDGE_FIXTURE=1 via playwright.config.ts). " +
        "Stop any other server on the configured port and rerun."
    );
  }
});

test("landing shows search, categories, articles, and the create action", async ({
  page,
}) => {
  await page.goto(FIXTURE);
  await waitForAnimations(page);

  await expect(
    page.getByRole("heading", { name: "Knowledge Base", level: 1 })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /New article/ })
  ).toBeVisible();
  await expect(page.getByLabel("Search the Knowledge Base")).toBeVisible();
  // Category section and a fixture article render.
  const category = page.getByRole("region", { name: "Brewery Operations" });
  await expect(
    category.getByRole("link", { name: /Example SOP/ })
  ).toBeVisible();
});

test("landing search filters articles via the API seam", async ({ page }) => {
  await page.goto(FIXTURE);
  const search = page.getByLabel("Search the Knowledge Base");
  await search.fill("opening");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results).toBeVisible();
  await expect(
    results.getByRole("link", { name: /Example Checklist/ })
  ).toBeVisible();
  await expect(
    results.getByRole("link", { name: /Example SOP/ })
  ).toBeHidden();
});

test("published article renders callouts, TOC, nav, breadcrumbs, print action", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?view=article`);
  await waitForAnimations(page);

  // Breadcrumbs + meta.
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Example SOP: Formatting Reference", level: 1 })
  ).toBeVisible();

  // Callouts render with type classes and titles.
  await expect(page.locator(".kb-callout-warning")).toBeVisible();
  await expect(page.locator(".kb-callout-note")).toBeVisible();
  await expect(page.locator(".kb-callout-tip")).toBeVisible();
  await expect(page.locator(".kb-callout-danger")).toBeVisible();

  // A plain blockquote stays distinct from callouts.
  await expect(
    page.locator(".kb-prose blockquote")
  ).toHaveCount(1);

  // Desktop TOC + left nav (Desktop Chrome viewport).
  await expect(
    page.getByRole("navigation", { name: "On this page" })
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Knowledge Base sections" })
  ).toBeVisible();

  // TOC link targets a real heading id.
  await page
    .getByRole("navigation", { name: "On this page" })
    .getByRole("link", { name: "Procedure" })
    .click();
  await expect(page).toHaveURL(/#procedure$/);
  await expect(page.locator("h2#procedure")).toBeVisible();

  // Actions: edit, history, print.
  await expect(page.getByRole("link", { name: "Edit" })).toBeVisible();
  await expect(page.getByRole("link", { name: "History" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Print / Save PDF" })
  ).toBeVisible();
});

test("mobile viewport uses collapsible nav and TOC disclosures", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${FIXTURE}?view=article`);
  await waitForAnimations(page);

  // Rails are hidden below lg/xl; disclosures replace them.
  const browse = page.locator("summary", { hasText: "Browse Knowledge Base" });
  const onThisPage = page.locator("summary", { hasText: "On this page" });
  await expect(browse).toBeVisible();
  await expect(onThisPage).toBeVisible();

  await browse.click();
  await expect(
    page.getByRole("navigation", { name: "Knowledge Base sections" })
  ).toBeVisible();
});

test("editor renders fields, toolbar, and live preview", async ({ page }) => {
  await page.goto(`${FIXTURE}?view=edit`);
  await waitForAnimations(page);

  await expect(
    page.getByRole("heading", { name: /Edit: Example SOP/, level: 1 })
  ).toBeVisible();
  const body = page.getByLabel("Article Markdown");
  await expect(body).toBeVisible();
  await expect(body).toHaveValue(/Example SOP/);

  // Toolbar controls are labelled.
  await expect(
    page.getByRole("button", { name: "Heading 2" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Warning callout" })
  ).toBeVisible();

  // Preview tab renders the same component as the published view.
  await page.getByRole("tab", { name: "Preview" }).click();
  await expect(page.locator(".kb-prose .kb-callout-warning")).toBeVisible();
});

test("history lists fixture revisions", async ({ page }) => {
  await page.goto(`${FIXTURE}?view=history`);
  await waitForAnimations(page);

  await expect(
    page.getByRole("heading", { name: /Revision history/ })
  ).toBeVisible();
  await expect(page.getByText("v001")).toBeVisible();
  await expect(page.getByText("v002")).toBeVisible();
});

test("axe: knowledge fixture surfaces have no serious/critical violations", async ({
  page,
}) => {
  const ready: Record<string, string> = {
    landing: "Example SOP",
    article: "Demonstrates how a standard operating procedure reads",
    edit: "Edit: Example SOP",
    history: "Revision history",
  };
  for (const view of ["landing", "article", "edit", "history"]) {
    await page.goto(`${FIXTURE}?view=${view}`);
    await waitForAnimations(page);
    // Wait for the fixture API data to render before scanning.
    await expect(
      page.locator("#main-content").getByText(ready[view]).first()
    ).toBeVisible();
    const blocking = await scanAxe(page, `${FIXTURE} (${view})`);
    expect(
      blocking,
      formatBlocking(`${FIXTURE} (${view})`, blocking)
    ).toEqual([]);
  }
});
