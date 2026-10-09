import { test, expect } from "./fixtures";
import type { Locator } from "playwright/test";
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

test("article document title names the PDF export after the article", async ({
  page,
  browser,
}) => {
  // Browsers use document.title as the default Print → Save as PDF filename.
  await page.goto(`${FIXTURE}?view=article`);
  await expect(page).toHaveTitle(
    "Example SOP: Formatting Reference | Knowledge Base | Deep Dive Brewing Co"
  );

  // Drafts get the same treatment.
  await page.goto(`${FIXTURE}?view=draft`);
  await expect(page).toHaveTitle(
    "Example Draft Reference | Knowledge Base | Deep Dive Brewing Co"
  );

  // A missing article keeps the generic page title. A raw page is used
  // because the missing-article path intentionally logs a console error,
  // which the shared fixture treats as a failure.
  const raw = await browser.newPage();
  try {
    await raw.goto(`${FIXTURE}?view=missing`);
    await expect(raw.getByText("Article not found")).toBeVisible();
    await expect(raw).toHaveTitle(
      "Admin knowledge fixture | Deep Dive Brewing Co"
    );
  } finally {
    await raw.close();
  }
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

test("editor attachment picker lists, inserts, and deletes fixture files", async ({
  page,
}) => {
  // Image thumbnails fetch through the real Storage getBlob path; fulfill it
  // with a 1px image so the fixture exercises it without a real bucket.
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  await page.route(/firebasestorage\.googleapis\.com/, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: pixel })
  );

  await page.goto(`${FIXTURE}?view=edit`);
  await waitForAnimations(page);
  const body = page.getByLabel("Article Markdown");
  const openPicker = () =>
    page.getByRole("button", { name: "Attachments" }).click();
  const row = (dialog: Locator, name: string) =>
    dialog.locator("li", { hasText: name });

  const JPG = "1700000000000-keg-washer.jpg";
  const PDF = "1700000001000-cip-checklist.pdf";

  // Listing: both fixture objects appear with their types.
  await openPicker();
  let dialog = page.getByRole("dialog");
  await expect(row(dialog, JPG)).toBeVisible();
  await expect(row(dialog, PDF)).toBeVisible();

  // Inserting an image writes the ![alt](kb:…) form at the cursor.
  await row(dialog, JPG).getByRole("button", { name: "Insert" }).click();
  await expect(body).toHaveValue(
    new RegExp(`!\\[${JPG}\\]\\(kb:example-sop/${JPG}\\)`)
  );

  // Collapse the selection the first insert left behind so the next insert
  // is a fresh link, not a re-wrap of the placeholder text.
  await body.click();
  await body.press("Control+End");

  // Inserting a PDF writes the [label](kb:…) link form.
  await openPicker();
  dialog = page.getByRole("dialog");
  await row(dialog, PDF).getByRole("button", { name: "Insert" }).click();
  await expect(body).toHaveValue(
    new RegExp(`\\[${PDF}\\]\\(kb:example-sop/${PDF}\\)`)
  );

  // A file referenced by the current draft cannot be deleted — the UI blocks
  // it before the server-side check ever runs.
  await openPicker();
  dialog = page.getByRole("dialog");
  await expect(
    row(dialog, JPG).getByText("Referenced in draft")
  ).toBeVisible();
  await row(dialog, JPG).getByRole("button", { name: "Delete" }).click();
  await expect(
    dialog.getByText(/still referenced by the draft below/)
  ).toBeVisible();
  await expect(
    row(dialog, JPG).getByRole("button", { name: "Confirm delete" })
  ).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Once the draft no longer references the files, deletion asks for
  // confirmation and then removes each row.
  await body.fill("## Purpose\n\nNo attachments referenced.\n");
  await openPicker();
  dialog = page.getByRole("dialog");
  for (const name of [JPG, PDF]) {
    await row(dialog, name).getByRole("button", { name: "Delete" }).click();
    await row(dialog, name)
      .getByRole("button", { name: "Confirm delete" })
      .click();
    await expect(row(dialog, name)).toHaveCount(0);
    await expect(dialog.getByText(`Deleted ${name}.`)).toBeVisible();
  }
  await expect(dialog.getByText(/No attachments yet/)).toBeVisible();
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
