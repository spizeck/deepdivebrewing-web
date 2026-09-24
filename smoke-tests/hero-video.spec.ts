import { test, expect } from "./fixtures";

// Brewery video section (Issue #135). The decorative <video> is intentionally
// gated: reduced-motion and viewports <=768px get only the approved brewery
// still. On desktop the still is always rendered underneath and the video
// fades in over it only once it can actually play — the static state is a
// complete design, never an error screen.
//
// Headless browsers cannot prove real decoding/playback, so these tests
// assert the DOM contract (sources, attributes, gating, graceful failure);
// media bytes themselves are verified out-of-band with ffprobe.

const brewerySection = (page: import("playwright").Page) =>
  page.locator("section", {
    has: page.getByRole("heading", { name: "The Brewery", exact: true }),
  });

test("brewery section uses the approved still, not the grain hero image", async ({
  page,
}) => {
  await page.goto("/");
  const section = brewerySection(page);
  await expect(section).toBeVisible();

  // The section poster is the distinct brewery still…
  await expect(section.locator('img[src*="video-still"]')).toBeVisible();
  // …and never the duplicated grain hero photo.
  await expect(section.locator('img[src*="herograin"]')).toHaveCount(0);

  // The main hero above keeps the grain image.
  const hero = page.locator("section").first();
  await expect(hero.locator('img[src*="herograin"]')).toBeVisible();

  // Section remains a complete, readable design.
  await expect(
    section.getByRole("heading", { name: "The Brewery", exact: true })
  ).toBeVisible();
  await expect(section.getByRole("link", { name: "Learn More" })).toBeVisible();
});

test("desktop mounts a muted looping video with webm-first sources", async ({
  page,
}) => {
  await page.goto("/");
  const section = brewerySection(page);
  const video = section.locator("video");
  await expect(video).toBeAttached();
  await expect(video).toHaveAttribute("aria-hidden", "true");
  await expect(video).toHaveAttribute("muted", "");
  await expect(video).toHaveAttribute("loop", "");
  await expect(video).toHaveAttribute("playsinline", "");
  await expect(video).toHaveAttribute("preload", "none");
  // No poster attribute — the SSR'd attribute would fetch the raw file
  // before hydration, duplicating the optimized image download.
  await expect(video).not.toHaveAttribute("poster");

  const sources = video.locator("source");
  await expect(sources).toHaveCount(2);
  await expect(sources.nth(0)).toHaveAttribute("src", "/videos/ddbwebvid.webm");
  await expect(sources.nth(0)).toHaveAttribute("type", "video/webm");
  await expect(sources.nth(1)).toHaveAttribute("src", "/videos/ddbwebvid.mp4");
  await expect(sources.nth(1)).toHaveAttribute("type", "video/mp4");
});

test("the still stays underneath whether or not the video becomes ready", async ({
  page,
}) => {
  await page.goto("/");
  const section = brewerySection(page);
  await section.scrollIntoViewIfNeeded();

  const still = section.locator('img[src*="video-still"]');
  const video = section.locator("video");
  await expect(still).toBeVisible();
  // Before readiness the video is transparent over the still.
  if (!(await video.evaluate((v) => (v as HTMLVideoElement).readyState >= 4))) {
    await expect(video).toHaveClass(/opacity-0/);
  }
  // Once the browser reports it can play, the video fades in — the still
  // remains mounted underneath regardless.
  await video
    .evaluate(
      (v) =>
        new Promise<void>((resolve) => {
          const el = v as HTMLVideoElement;
          if (el.readyState >= 4) resolve();
          else el.addEventListener("canplay", () => resolve(), { once: true });
          setTimeout(resolve, 15000);
        })
    )
    .catch(() => {});
  await expect(still).toBeVisible();
  await expect(still).toBeAttached();
});

test("a refused play() leaves the still intact without an error surface", async ({
  page,
}) => {
  // Simulate an autoplay refusal (e.g. low-power mode) before any page code.
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () =>
      Promise.reject(new DOMException("Blocked", "NotAllowedError"));
  });
  await page.goto("/");
  const section = brewerySection(page);
  await section.scrollIntoViewIfNeeded();

  await expect(section.locator('img[src*="video-still"]')).toBeVisible();
  await expect(
    section.getByRole("heading", { name: "The Brewery", exact: true })
  ).toBeVisible();
  // The video mounts but never fades in; nothing breaks.
  const video = section.locator("video");
  await expect(video).toBeAttached();
  await expect(video).toHaveClass(/opacity-0/);
});

test("the video layer cannot shift layout when it appears", async ({
  page,
}) => {
  await page.goto("/");
  const section = brewerySection(page);
  await section.scrollIntoViewIfNeeded();
  const before = await section.boundingBox();
  // The video is absolutely positioned inside the fixed-height section.
  const position = await section
    .locator("video")
    .evaluate((el) => getComputedStyle(el).position);
  expect(position).toBe("absolute");
  await page.waitForTimeout(1500);
  const after = await section.boundingBox();
  expect(after?.height).toBe(before?.height);
  expect(after?.width).toBe(before?.width);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    )
  ).toBe(false);
});

test("small viewports get only the still — no video element at all", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  const section = brewerySection(page);
  await expect(section.locator("video")).toHaveCount(0);
  await expect(section.locator('img[src*="video-still"]')).toBeVisible();
  await expect(
    section.getByRole("heading", { name: "The Brewery", exact: true })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    )
  ).toBe(false);
});

test("reduced motion gets only the approved still", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const section = brewerySection(page);
  await expect(section.locator("video")).toHaveCount(0);
  await expect(section.locator('img[src*="video-still"]')).toBeVisible();
});
