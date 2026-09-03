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
  const posterCount = await page.locator('img[src="/photos/herograin.jpg"]').count();

  // Count only the brewery section image/poster (the hero has one too).
  console.log(`${label}: video elements=${videoCount}, herograin images=${posterCount}`);
  await context.close();
}

// Desktop default (should eventually show video after intersection + client hydration).
await check({}, "desktop-default");
// Mobile viewport.
await check({ viewport: { width: 375, height: 812 } }, "mobile-375");
// Reduced motion.
await check({ reducedMotion: "reduce" }, "reduced-motion");

await browser.close();
