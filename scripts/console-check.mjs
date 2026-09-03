import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const pages = ["/", "/beers", "/where-to-buy", "/contact", "/trade"];
const widths = [1280, 390, 320];

const browser = await chromium.launch({ headless: true });
let failed = false;

for (const path of pages) {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    const warnings = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
      if (msg.type() === "warning") warnings.push(msg.text());
    });

    page.on("pageerror", (err) => errors.push(err.message));

    try {
      await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle", timeout: 15000 });
      await page.waitForTimeout(1000);
      console.log(`${path} @ ${width}px — errors: ${errors.length}, warnings: ${warnings.length}`);
      for (const e of errors) console.log(`  ERROR: ${e}`);
      for (const w of warnings) console.log(`  WARN: ${w}`);
      if (errors.length > 0) failed = true;
    } catch (err) {
      console.error(`${path} @ ${width}px: navigation error - ${err.message}`);
      failed = true;
    } finally {
      await context.close();
    }
  }
}

await browser.close();
process.exit(failed ? 1 : 0);
