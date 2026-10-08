import { test, expect } from "./fixtures";

// Interaction-feedback contract (Issue #166): the shared tactile language —
// eased state transitions plus the motion-safe press scale — must reach the
// surfaces the site-wide audit flagged as inconsistent. Assertions read
// computed styles, not class names, so a utility rename fails only when the
// rendered behavior actually changes.

async function transitionOf(
  locator: import("playwright/test").Locator
): Promise<{ property: string; duration: string }> {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      property: style.transitionProperty,
      duration: style.transitionDuration,
    };
  });
}

test("nav links ease color feedback at desktop and mobile widths", async ({
  page,
}) => {
  await page.goto("/beers");
  const desktopLink = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Where to Buy" });
  const desktop = await transitionOf(desktopLink);
  expect(desktop.property).toContain("color");
  expect(desktop.duration).not.toBe("0s");

  // The mobile menu links run the same eased color treatment as the desktop
  // pill links — before #166 they switched states instantly.
  await page.setViewportSize({ width: 390, height: 844 });
  const toggle = page.locator("button[aria-controls]");
  await toggle.press("Enter");
  const mobileLink = page
    .getByRole("navigation", { name: "Mobile" })
    .getByRole("link", { name: "Where to Buy" });
  await expect(mobileLink).toBeVisible();
  const mobile = await transitionOf(mobileLink);
  expect(mobile.property).toContain("color");
  expect(mobile.duration).not.toBe("0s");
});

test("page text links ease their opacity feedback", async ({ page }) => {
  await page.goto("/beers");
  for (const name of ["Where to Buy page", "Submit a trade inquiry"]) {
    const timing = await transitionOf(page.getByRole("link", { name }));
    expect(timing.property).toContain("opacity");
    expect(timing.duration).not.toBe("0s");
  }
});

test("prose links ease their hover opacity like component text links", async ({
  page,
}) => {
  await page.goto("/privacy");
  const link = page.locator('.prose-dd a[href^="mailto:"]').first();
  await expect(link).toBeVisible();
  const timing = await transitionOf(link);
  expect(timing.property).toContain("opacity");
  expect(timing.duration).not.toBe("0s");
});

test("tour date-picker trigger acknowledges a pointer press", async ({
  page,
}) => {
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();
  const trigger = page
    .getByRole("dialog")
    .locator('button[aria-haspopup="grid"]');
  await expect(trigger).toBeVisible();

  const timing = await transitionOf(trigger);
  expect(timing.property).toContain("scale");

  await trigger.hover();
  await page.mouse.down();
  // Tailwind's scale-* utilities set the standalone `scale` property, not
  // `transform` — assert the property the press actually animates.
  const scale = await trigger.evaluate((el) => getComputedStyle(el).scale);
  await page.mouse.up();
  expect(scale).not.toBe("none");
});

test("press feedback never transforms under reduced motion", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/contact");
  await page.getByRole("button", { name: "Arrange a brewery tour" }).click();
  const trigger = page
    .getByRole("dialog")
    .locator('button[aria-haspopup="grid"]');
  await expect(trigger).toBeVisible();

  await trigger.hover();
  await page.mouse.down();
  const scale = await trigger.evaluate((el) => getComputedStyle(el).scale);
  await page.mouse.up();
  expect(scale).toBe("none");

  // Eased transitions added in #166 collapse to instant under reduced
  // motion while the color/opacity state change itself remains.
  await page.goto("/beers");
  const timing = await transitionOf(
    page.getByRole("link", { name: "Where to Buy page" })
  );
  expect(timing.duration).toBe("0s");
});

test("beer cards acknowledge a pointer press", async ({ page }) => {
  // Fixture card links point at /beers/<fixture-slug> routes that 404
  // (dynamicParams = false). Aborting the viewport prefetch keeps the
  // failure guard quiet (net::ERR_ABORTED on _rsc requests is tolerated),
  // and suppressing the click's default keeps the press from navigating —
  // the same pairing the carousel suite uses.
  await page.route("**/beers/**", (route) => route.abort("aborted"));
  await page.addInitScript(() => {
    document.addEventListener(
      "click",
      (event) => {
        if ((event.target as Element).closest("a")) event.preventDefault();
      },
      true
    );
  });
  const response = await page.goto("/carousel-fixture");
  test.skip(
    response?.status() === 404,
    "fixture route disabled (CAROUSEL_FIXTURE env not set)"
  );

  const card = page
    .locator('[aria-roledescription="slide"]')
    .first()
    .locator("a");
  await card.hover();
  await page.mouse.down();
  const scale = await card.evaluate((el) => getComputedStyle(el).scale);
  await page.mouse.up();
  expect(scale).not.toBe("none");
});
