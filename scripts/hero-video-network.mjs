import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ headless: true });

async function check(label, contextOptions) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ...contextOptions,
  });
  const page = await context.newPage();

  const videoUrls = [];
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/videos/")) videoUrls.push(url);
  });

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(1500);

  console.log(`${label}: video network requests = ${videoUrls.length}`);
  for (const u of videoUrls) console.log(`  - ${u}`);
  await context.close();
}

// Mobile viewport should not request video.
await check("mobile-375", { viewport: { width: 375, height: 812 } });
// Reduced motion should not request video.
await check("reduced-motion", { reducedMotion: "reduce" });
// Desktop default will request video once it scrolls into view.
await check("desktop-default", {});

await browser.close();
