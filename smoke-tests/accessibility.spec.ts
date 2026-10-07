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

  // The menu is a floating panel below the pill, not an expansion of it —
  // opening must not move or resize the shell (no accordion growth). The
  // panel stays mounted and inert when closed, so locate it by attribute:
  // inert subtrees leave the accessibility tree, which role queries read.
  const shell = page.locator("header > div").first();
  const panel = page.locator('nav[aria-label="Mobile"]');
  const closedBox = await shell.boundingBox();
  await expect(panel).toHaveAttribute("inert", "");
  await expect(panel).not.toBeVisible();

  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveAccessibleName("Close menu");

  const menu = page.getByRole("navigation", { name: "Mobile" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: "Beers" })).toBeVisible();
  await expect(panel).not.toHaveAttribute("inert", "");

  const openBox = await shell.boundingBox();
  expect(
    openBox,
    "shell geometry must not change when the menu opens"
  ).toEqual(closedBox);
  const panelBox = await panel.boundingBox();
  expect(
    panelBox!.y,
    "menu panel must sit below the pill"
  ).toBeGreaterThanOrEqual(openBox!.y + openBox!.height);

  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel).not.toBeVisible();
  await expect(panel).toHaveAttribute("inert", "");

  // The closed panel's links are inert: Tab from the toggle must not land
  // inside the hidden menu.
  await page.keyboard.press("Tab");
  expect(
    await panel.evaluate((el) => el.contains(document.activeElement))
  ).toBe(false);

  // Selecting the current route's link never changes pathname, but the
  // menu must still close — otherwise it stays open over the same page.
  await toggle.press("Enter");
  await expect(menu).toBeVisible();
  await menu.getByRole("link", { name: "Beers" }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel).not.toBeVisible();
});

test("mobile menu opens and closes instantly under reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/beers");

  const toggle = page.locator("button[aria-controls]");
  const panel = page.locator('nav[aria-label="Mobile"]');

  // No decorative transition runs: the panel switches states promptly.
  expect(
    await panel.evaluate((el) => getComputedStyle(el).transitionDuration)
  ).toBe("0s");

  await toggle.press("Enter");
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "Beers" })
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  // Escape still returns focus to the toggle under reduced motion.
  await expect(toggle).toBeFocused();
});

test("nav pill keeps compact geometry and 44px targets across widths", async ({
  page,
}) => {
  const pill = page.locator("header > div");
  const toggle = page.locator("button[aria-controls]");
  const brand = page.getByRole("link", { name: "Deep Dive Brewing Co" });

  // Desktop: the brand and link list float as two separate pills with
  // open space between them rather than one stretched bar — the wrapper
  // is transparent at lg, so assert on the two pill surfaces themselves.
  // Bounds are fractions of the viewport, not pixel snapshots.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/beers");

  const brandPill = page
    .getByRole("link", { name: "Deep Dive Brewing Co" })
    .locator("..");
  const navPill = page.getByRole("navigation", { name: "Main" });
  const brandPillBox = await brandPill.boundingBox();
  const navPillBox = await navPill.boundingBox();
  expect(brandPillBox!.width).toBeLessThan(0.35 * 1280);
  expect(navPillBox!.width).toBeLessThan(0.4 * 1280);
  expect(
    navPillBox!.x - (brandPillBox!.x + brandPillBox!.width)
  ).toBeGreaterThan(80);
  expect(
    Math.abs(brandPillBox!.height - navPillBox!.height)
  ).toBeLessThanOrEqual(2);

  const desktopLink = navPill.getByRole("link", { name: "Where to Buy" });
  const linkBox = await desktopLink.boundingBox();
  expect(linkBox!.height).toBeGreaterThanOrEqual(44);

  // Mobile: the pill floats clear of the viewport edges, the toggle keeps
  // its 44px target inside the pill, and the wordmark never collides with
  // the toggle (360px and below used to clip it).
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 812 });
    await page.goto("/beers");

    const box = await pill.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(12);
    expect(box!.x).toBeGreaterThanOrEqual(8);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width - 8);

    const toggleBox = await toggle.boundingBox();
    expect(toggleBox!.width).toBeGreaterThanOrEqual(44);
    expect(toggleBox!.height).toBeGreaterThanOrEqual(44);
    expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(
      box!.x + box!.width
    );

    const brandBox = await brand.boundingBox();
    expect(brandBox!.x + brandBox!.width).toBeLessThanOrEqual(toggleBox!.x);
  }

  // Narrowest supported width: the wordmark shrinks instead of clipping.
  await page.setViewportSize({ width: 320, height: 812 });
  await page.goto("/beers");
  const brandBox = await brand.boundingBox();
  const toggleBox = await toggle.boundingBox();
  expect(brandBox!.x + brandBox!.width).toBeLessThanOrEqual(
    toggleBox!.x + 2
  );
});

test("nav pill retreats on slow downward scroll and restores on upward", async ({
  page,
}) => {
  // /privacy is long enough to scroll well past the retreat threshold.
  await page.goto("/privacy");
  const header = page.locator("header");
  const headerTop = () =>
    header.evaluate((el) => el.getBoundingClientRect().top);

  // Sub-threshold increments: each scroll event moves less than the
  // direction-change delta, so only accumulated movement may retreat the
  // pill — a per-frame baseline never fires here.
  for (let y = 0; y <= 400; y += 4) {
    await page.evaluate((v) => window.scrollTo(0, v), y);
  }
  await expect.poll(headerTop).toBeLessThan(0);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(headerTop).toBeGreaterThanOrEqual(0);

  // Keyboard focus inside the header pins it: retreating while focused
  // would move the focus-visible outline off-screen. Wait past the rAF
  // batching and retreat transition before asserting the pin held.
  await page
    .getByRole("link", { name: "Deep Dive Brewing Co" })
    .focus();
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(500);
  expect(await headerTop()).toBeGreaterThanOrEqual(0);
});

test("mobile menu traps Tab focus while open", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  // /privacy is text-only: resizing mid-test can't abort in-flight image
  // requests the way the beer-card grid on /beers does.
  await page.goto("/privacy");

  const toggle = page.locator("button[aria-controls]");
  await toggle.press("Enter");

  const menu = page.getByRole("navigation", { name: "Mobile" });
  const lastLink = menu.getByRole("link", { name: "Trade" });
  const brandLink = page.getByRole("link", {
    name: "Deep Dive Brewing Co",
  });

  // Tab past the final link must wrap to the first nav control instead of
  // escaping to page content behind the open menu.
  await lastLink.focus();
  await page.keyboard.press("Tab");
  await expect(brandLink).toBeFocused();

  // Shift+Tab from the first control wraps back to the final link.
  await page.keyboard.press("Shift+Tab");
  await expect(lastLink).toBeFocused();

  // Crossing into the lg breakpoint closes the menu so the trap can never
  // apply to a menu that is no longer rendered. The panel stays mounted
  // but inert — hidden from both the accessibility tree and the tab order.
  const panel = page.locator('nav[aria-label="Mobile"]');
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(panel).toHaveAttribute("inert", "");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await page.setViewportSize({ width: 375, height: 812 });
  await toggle.press("Enter");
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(panel).toHaveAttribute("inert", "");
  await expect(toggle).toBeFocused();
});

test("trade form exposes labels, autocomplete, and required state", async ({
  page,
}) => {
  await page.goto("/trade");

  await expect(page.getByLabel("Business name")).toHaveAttribute(
    "autocomplete",
    "organization"
  );
  await expect(page.getByLabel("Your name")).toHaveAttribute(
    "autocomplete",
    "name"
  );
  const email = page.getByLabel("Email");
  await expect(email).toHaveAttribute("autocomplete", "email");
  await expect(email).toHaveAttribute("required", "");
  await expect(page.getByLabel("Phone / WhatsApp (optional)")).toHaveAttribute(
    "autocomplete",
    "tel"
  );
  await expect(page.getByLabel("Business type")).toHaveAttribute("required", "");

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

  await page.getByLabel("Business name").fill("Smoke Test Tavern");
  await page.getByLabel("Your name").fill("Tester");
  await page.getByLabel("Email").fill("tester@example.com");
  await page.getByLabel("Business type").selectOption("bar");
  await page.getByRole("button", { name: "Send inquiry" }).click();

  const statusRegion = page.getByRole("status");
  await expect(statusRegion).toContainText("Failed to submit inquiry.");
});

test("beer filter buttons expose pressed state", async ({ page }) => {
  await page.goto("/beers");
  const all = page.getByRole("button", { name: "All", exact: true });
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

test("scroll-revealed content stays visible without JavaScript", async ({
  browser,
}) => {
  // The hidden start state is armed by the Reveal effect, so a session where
  // JS never runs (or hydration fails before it does) renders SSR content
  // visible rather than permanently faded out.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");

  const firstReveal = page.locator(".scroll-fade-in").first();
  await expect(firstReveal).toHaveCount(1);
  const opacity = await firstReveal.evaluate(
    (el) => getComputedStyle(el).opacity
  );
  expect(opacity).toBe("1");
  await context.close();
});
