import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const pages = ["/", "/beers", "/where-to-buy", "/contact", "/trade"];
const widths = [320, 390, 1280];

const browser = await chromium.launch({ headless: true });
let failed = false;

for (const path of pages) {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle", timeout: 15000 });
      await page.waitForTimeout(500);
      const hasOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      const status = hasOverflow ? "OVERFLOW" : "ok";
      console.log(`${path} @ ${width}px: ${status}`);
      if (hasOverflow) failed = true;
    } catch (err) {
      console.error(`${path} @ ${width}px: error - ${err.message}`);
      failed = true;
    } finally {
      await context.close();
    }
  }
}

await browser.close();
process.exit(failed ? 1 : 0);
