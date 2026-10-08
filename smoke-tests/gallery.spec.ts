import { test, expect } from "./fixtures";
import { AxeBuilder } from "@axe-core/playwright";

// "Inside Deep Dive" gallery + lightbox on /about (Issue #193).
// Behavioral coverage for the interactive surface: enlarge triggers,
// dialog open/close semantics, arrow-key and button navigation, and the
// announced photo counter. axe policy matches accessibility.spec.ts —
// serious/critical violations block.

const ENLARGE = /Enlarge photo/;
const dialog = (page: import("playwright/test").Page) =>
  page.getByRole("dialog");

test("about gallery figures render with enlarge triggers", async ({
  page,
}) => {
  await page.goto("/about");
  await expect(
    page.getByRole("heading", { name: "Inside Deep Dive" })
  ).toBeVisible();
  // Seven curated photos, each an accessible enlarge button.
  const triggers = page.getByRole("button", { name: ENLARGE });
  await expect(triggers).toHaveCount(7);
  await expect(triggers.first()).toBeVisible();
});

test("lightbox opens on Enter, closes on Escape, and restores focus", async ({
  page,
}) => {
  await page.goto("/about");
  const trigger = page.getByRole("button", { name: ENLARGE }).first();

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close photo viewer" })
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("lightbox steps through photos with arrows and buttons", async ({
  page,
}) => {
  await page.goto("/about");
  await page
    .getByRole("button", { name: ENLARGE })
    .first()
    .press("Enter");
  const viewer = dialog(page);
  await expect(viewer).toBeVisible();
  await expect(viewer).toContainText("Photo 1 of 7");

  // Keyboard navigation wraps through the set.
  await page.keyboard.press("ArrowRight");
  await expect(viewer).toContainText("Photo 2 of 7");
  await page.keyboard.press("ArrowLeft");
  await expect(viewer).toContainText("Photo 1 of 7");
  await page.keyboard.press("ArrowLeft");
  await expect(viewer).toContainText("Photo 7 of 7");

  // Buttons do the same and carry names for AT.
  await page.getByRole("button", { name: "Next photo" }).click();
  await expect(viewer).toContainText("Photo 1 of 7");
  await page.getByRole("button", { name: "Previous photo" }).click();
  await expect(viewer).toContainText("Photo 7 of 7");

  // The current photo's caption is the dialog's description.
  await expect(viewer).toContainText("Wort running through the sight glass");
});

test("lightbox controls stay usable on a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/about");
  await page
    .getByRole("button", { name: ENLARGE })
    .first()
    .press("Enter");
  const viewer = dialog(page);
  await expect(viewer).toBeVisible();

  for (const name of ["Previous photo", "Next photo", "Close photo viewer"]) {
    const control = page.getByRole("button", { name });
    await expect(control).toBeVisible();
    const box = await control.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
});

test("axe: open lightbox has no serious/critical violations", async ({
  page,
}) => {
  await page.goto("/about");
  await page
    .getByRole("button", { name: ENLARGE })
    .first()
    .press("Enter");
  await expect(dialog(page)).toBeVisible();
  // Let the open fade finish before measuring contrast.
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every((animation) =>
            ["finished", "idle"].includes(animation.playState)
          ),
      undefined,
      { timeout: 5_000 }
    )
    .catch(() => {});

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  const blocking = results.violations.filter((violation) =>
    ["critical", "serious"].includes(violation.impact ?? "")
  );
  expect(
    blocking,
    `serious/critical axe violations in open lightbox:\n${blocking
      .map((v) => `${v.id} (${v.impact}): ${v.help}`)
      .join("\n")}`
  ).toEqual([]);
});
