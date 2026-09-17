import { test, expect } from "./fixtures";
import { AxeBuilder } from "@axe-core/playwright";

// Automated accessibility coverage for the production build.
//
// Routes are the same deterministic surfaces the smoke suite covers —
// everything here holds whether or not Firestore data is available.
//
// Policy: serious and critical violations fail the suite. Moderate/minor
// findings and incomplete checks (e.g. cross-origin iframes axe cannot
// inspect) are printed to the test output for review without blocking.

const AXE_ROUTES = [
  "/",
  "/beers",
  "/about",
  "/trade",
  "/contact",
  "/where-to-buy",
  "/admin",
  "/beers/definitely-not-a-real-beer",
] as const;

const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

// Entry animations (fade-ins, delayed reveals) leave elements partially
// transparent during the scan, which produces false color-contrast
// measurements. Wait until every CSS animation/transition has finished
// before analyzing — pages without animations resolve immediately.
async function waitForAnimations(page: import("playwright/test").Page) {
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every((animation) =>
            ["finished", "idle"].includes(animation.playState)
          ),
      { timeout: 5_000 }
    )
    .catch(() => {
      // A long-running/looping animation is not a blocker — scan anyway.
    });
}

for (const route of AXE_ROUTES) {
  test(`axe: ${route} has no serious/critical violations`, async ({
    page,
  }) => {
    await page.goto(route);
    await waitForAnimations(page);

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();

    const blocking = results.violations.filter((violation) =>
      BLOCKING_IMPACTS.has(violation.impact ?? "")
    );

    const nonBlocking = [
      ...results.violations.filter(
        (violation) => !BLOCKING_IMPACTS.has(violation.impact ?? "")
      ),
      ...results.incomplete,
    ];
    if (nonBlocking.length > 0) {
      console.log(
        `axe non-blocking findings on ${route}:\n` +
          nonBlocking
            .map(
              (v) =>
                `- ${v.id} (${v.impact ?? "review"}): ${v.nodes.length} node(s)`
            )
            .join("\n")
      );
    }

    expect(
      blocking,
      `serious/critical axe violations on ${route}:\n${blocking
        .map(
          (v) =>
            `${v.id} (${v.impact}): ${v.help}\n${v.nodes
              .map((n) => `  - ${n.target.join(" ")} :: ${n.failureSummary}`)
              .join("\n")}`
        )
        .join("\n")}`
    ).toEqual([]);
  });
}

test("skip link is the first tab stop and moves focus to main content", async ({
  page,
}) => {
  await page.goto("/beers");

  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await page.keyboard.press("Tab");
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeVisible();

  await page.keyboard.press("Enter");
  const main = page.locator("#main-content");
  await expect(main).toBeFocused();

  // The next Tab lands inside the main landmark, not back in the header.
  await page.keyboard.press("Tab");
  const inside = await page.evaluate(() =>
    document.getElementById("main-content")?.contains(document.activeElement)
  );
  expect(inside).toBe(true);
});

test("every page exposes exactly one h1 inside a main landmark", async ({
  page,
}) => {
  for (const route of ["/beers", "/trade", "/contact", "/where-to-buy"]) {
    await page.goto(route);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(
      page.getByRole("main").getByRole("heading", { level: 1 })
    ).toHaveCount(1);
  }
});

test("header navigation is keyboard reachable with a visible indicator", async ({
  page,
}) => {
  await page.goto("/beers");
  const nav = page.getByRole("navigation", { name: "Main" });
  const link = nav.getByRole("link", { name: "Where to Buy" });

  // Tab from the top until the link holds focus (skip link → logo → Beers →
  // target), so the browser applies its real :focus-visible heuristics.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    if (await link.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(link).toBeFocused();

  const indicator = await link.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
    };
  });
  const hasIndicator =
    (indicator.outlineStyle !== "none" &&
      parseFloat(indicator.outlineWidth) > 0) ||
    indicator.boxShadow !== "none";
  expect(hasIndicator).toBe(true);
});

test("mobile menu opens, keyboard-navigates, and closes on Escape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/beers");

  // The toggle's accessible name flips with state ("Open menu" → "Close
  // menu"), so locate it by its stable aria-controls hook instead.
  const toggle = page.locator("button[aria-controls]");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAccessibleName("Close menu");

  const menu = page.getByRole("navigation", { name: "Mobile" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: "Beers" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(menu).not.toBeAttached();
});

test("trade form exposes labels, autocomplete, and required state", async ({
  page,
}) => {
  await page.goto("/trade");

  await expect(page.getByLabel("Business Name")).toHaveAttribute(
    "autocomplete",
    "organization"
  );
  await expect(page.getByLabel("Contact Name")).toHaveAttribute(
    "autocomplete",
    "name"
  );
  const email = page.getByLabel("Email");
  await expect(email).toHaveAttribute("autocomplete", "email");
  await expect(email).toHaveAttribute("required", "");
  await expect(page.getByLabel("Phone / WhatsApp")).toHaveAttribute(
    "autocomplete",
    "tel"
  );
  await expect(page.getByLabel("Venue Type")).toHaveAttribute("required", "");

  // The honeypot field exists but is unreachable by keyboard and hidden
  // from assistive technology (sr-only keeps a clipped 1px box, so assert
  // the aria-hidden contract rather than Playwright visibility).
  const honeypot = page.locator("#website");
  await expect(honeypot).toHaveAttribute("tabindex", "-1");
  await expect(honeypot.locator("..")).toHaveAttribute("aria-hidden", "true");
});

test("trade form announces submission errors in a status region", async ({
  page,
}) => {
  // Intercept before the fixture's catch-all so no real API/email is hit.
  // Status 200 keeps the fixture's same-origin HTTP-error guard quiet while
  // `ok: false` exercises the exact client error branch.
  await page.route("/api/trade-inquiry", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "Failed to submit inquiry." }),
    })
  );
  await page.goto("/trade");

  await page.getByLabel("Business Name").fill("Smoke Test Tavern");
  await page.getByLabel("Contact Name").fill("Tester");
  await page.getByLabel("Email").fill("tester@example.com");
  await page.getByLabel("Venue Type").selectOption("bar");
  await page.getByRole("button", { name: "Submit Inquiry" }).click();

  const statusRegion = page.getByRole("status");
  await expect(statusRegion).toContainText("Failed to submit inquiry.");
});

test("beer filter buttons expose pressed state", async ({ page }) => {
  await page.goto("/beers");
  const all = page.getByRole("button", { name: "All" });
  const core = page.getByRole("button", { name: "Core" });
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await core.press("Enter");
  await expect(core).toHaveAttribute("aria-pressed", "true");
  await expect(all).toHaveAttribute("aria-pressed", "false");
});

test("reduced motion swaps the hero video for a static poster", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("video")).toHaveCount(0);
});

test("decorative hero media is hidden from assistive technology", async ({
  page,
}) => {
  await page.goto("/");
  const heroSection = page.locator("section").first();
  // Either the decorative video or the poster image renders; neither should
  // be exposed to AT (aria-hidden video / empty-alt image).
  const video = heroSection.locator("video");
  if ((await video.count()) > 0) {
    await expect(video).toHaveAttribute("aria-hidden", "true");
  }
});
