import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ headless: true });

async function check(contextOptions, label) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...contextOptions,
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(800);

  const videoCount = await page.locator("video").count();
  const stillCount = await page.locator('img[src*="video-still"]').count();

  // The brewery section poster is the video still (Issue #135); the grain
  // hero image belongs to the hero section above it.
  console.log(`${label}: video elements=${videoCount}, video-still images=${stillCount}`);
  await context.close();
}

// Desktop default (should eventually show video after intersection + client hydration).
await check({}, "desktop-default");
// Mobile viewport.
await check({ viewport: { width: 375, height: 812 } }, "mobile-375");
// Reduced motion.
await check({ reducedMotion: "reduce" }, "reduced-motion");

await browser.close();
