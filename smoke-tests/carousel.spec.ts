import { test, expect } from "./fixtures";

// Interaction coverage for the homepage beer carousel, exercised against the
// deterministic /carousel-fixture route (enabled only by the Playwright
// webServer env — see playwright.config.ts). Six fixture slides mirror the
// homepage's featured slice so this runs even when the CI Firestore catalog
// is empty and the real homepage mounts zero slides.
//
// Regression guard: a pointer click on a card focuses its link, and focus
// bubbles to the slide wrapper. The slide may only scrollIntoView on
// *keyboard* focus (:focus-visible) — pointer focus must never re-align the
// carousel ahead of navigation.

const ROUTE = "/carousel-fixture";

const slides = (page: import("playwright").Page) =>
  page.locator('[aria-roledescription="slide"]');

const slideX = async (
  page: import("playwright").Page,
  index: number
): Promise<number> => {
  const box = await slides(page).nth(index).boundingBox();
  expect(box, `slide ${index} has a layout box`).toBeTruthy();
  return box!.x;
};

test.beforeEach(async ({ page }) => {
  // Fixture card links point at /beers/<fixture-slug> pages that don't exist
  // (dynamicParams = false), so Next's viewport prefetch would 404 and trip
  // the suite's failure guard. Aborting with net::ERR_ABORTED keeps them in
  // the fixture's existing tolerated class (cancelled _rsc prefetches), and
  // none of these tests perform a real document navigation.
  await page.route("**/beers/**", (route) => route.abort("aborted"));
  const response = await page.goto(ROUTE);
  test.skip(
    response?.status() === 404,
    "fixture route disabled (CAROUSEL_FIXTURE env not set)"
  );
  await expect(slides(page)).toHaveCount(6);
});

test("pointer click on a non-first card does not re-align the carousel", async ({
  page,
}) => {
  // Keep the page alive past the click so post-focus carousel state is
  // observable; the pointerdown → focus → scrollTo race this guards happens
  // before navigation in real usage.
  await page.addInitScript(() => {
    document.addEventListener(
      "click",
      (event) => {
        if ((event.target as Element).closest("a")) event.preventDefault();
      },
      true
    );
  });
  await page.reload();
  await expect(slides(page)).toHaveCount(6);

  const target = 2;
  const targetLink = slides(page).nth(target).locator("a");
  const targetHref = await targetLink.getAttribute("href");
  const beforeX = await slideX(page, target);

  // Focus fires on pointerdown, before click — the window where the bug
  // scrolled the tapped slide to the align:start position.
  await targetLink.hover();
  await page.mouse.down();
  await page.waitForTimeout(600); // an embla scroll animation would finish

  const duringX = await slideX(page, target);
  expect(
    Math.abs(duringX - beforeX),
    "carousel must not move when a card is clicked"
  ).toBeLessThan(2);

  await page.mouse.up();

  // The link still received focus (the buggy trigger condition existed) —
  // the fix suppresses the scroll, not the click/focus itself.
  const focused = await page.evaluate(
    () => document.activeElement?.getAttribute("href")
  );
  expect(focused).toBe(targetHref);
});

test("keyboard focus brings an off-screen slide into view", async ({
  page,
}) => {
  // Tab through the page until focus lands on a link inside a slide that is
  // fully/partially off the right edge, then the slide must scroll into view
  // — the keyboard accessibility behavior the pointer fix must preserve.
  const viewportWidth = page.viewportSize()!.width;
  let focusedSlide = -1;

  for (let i = 0; i < 30 && focusedSlide < 0; i++) {
    await page.keyboard.press("Tab");
    focusedSlide = await page.evaluate(() => {
      const slide = document.activeElement?.closest(
        '[aria-roledescription="slide"]'
      );
      if (!slide) return -1;
      return Array.from(
        document.querySelectorAll('[aria-roledescription="slide"]')
      ).indexOf(slide);
    });
  }
  expect(focusedSlide, "tab reached a carousel slide").toBeGreaterThanOrEqual(
    0
  );

  // Keep tabbing until an off-screen slide is focused (slides 3–5 at ~30%
  // width in a 1280px viewport).
  while (focusedSlide < 3) {
    await page.keyboard.press("Tab");
    focusedSlide = await page.evaluate(() => {
      const slide = document.activeElement?.closest(
        '[aria-roledescription="slide"]'
      );
      if (!slide) return -1;
      return Array.from(
        document.querySelectorAll('[aria-roledescription="slide"]')
      ).indexOf(slide);
    });
  }

  await page.waitForTimeout(600); // allow the scroll-into-view animation
  const x = await slideX(page, focusedSlide);
  expect(
    x,
    "keyboard-focused slide scrolls into view"
  ).toBeLessThan(viewportWidth);

  // Focus stayed on the card link, which reports :focus-visible.
  expect(
    await page.evaluate(() =>
      document.activeElement?.matches(":focus-visible")
    )
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.activeElement?.getAttribute("href") ?? ""
    )
  ).toMatch(/^\/beers\//);
});

test("pointer drag still scrolls the carousel", async ({ page }) => {
  const beforeX = await slideX(page, 0);

  // Real pointer sequence on the slide track: down → horizontal move → up.
  await slides(page).nth(0).hover();
  await page.mouse.down();
  await page.mouse.move(
    (await slides(page).nth(0).boundingBox())!.x - 250,
    page.viewportSize()!.height / 2,
    { steps: 12 }
  );
  await page.mouse.up();
  await page.waitForTimeout(600);

  expect(
    await slideX(page, 0),
    "dragging the track scrolls the carousel"
  ).toBeLessThan(beforeX - 50);
});

test("next/previous arrows scroll the carousel", async ({ page }) => {
  const beforeX = await slideX(page, 0);

  await page.getByRole("button", { name: "Next beer" }).click();
  await page.waitForTimeout(600);
  const afterNextX = await slideX(page, 0);
  expect(afterNextX).toBeLessThan(beforeX - 50);

  await page.getByRole("button", { name: "Previous beer" }).click();
  await page.waitForTimeout(600);
  expect(await slideX(page, 0)).toBeGreaterThan(afterNextX + 50);
});
