import { chromium } from "playwright";
import { mkdir } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "screenshots");
await mkdir(outDir, { recursive: true });

const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const pages = [
  { path: "/", name: "home" },
  { path: "/beers", name: "beers" },
  { path: "/where-to-buy", name: "where-to-buy" },
  { path: "/contact", name: "contact" },
  { path: "/trade", name: "trade" },
];
const viewports = [
  { width: 1280, height: 900, name: "desktop" },
  { width: 390, height: 844, name: "mobile-390" },
  { width: 320, height: 800, name: "mobile-320" },
];

const browser = await chromium.launch({ headless: true });

for (const page of pages) {
  for (const vp of viewports) {
    const context = await browser.newContext({ viewport: vp });
    const p = await context.newPage();
    const url = `${baseUrl}${page.path}`;
    try {
      await p.goto(url, { waitUntil: "networkidle", timeout: 15000 });
      // Wait a beat for client-side layout.
      await p.waitForTimeout(500);
      const file = join(outDir, `${page.name}-${vp.name}.png`);
      await p.screenshot({ path: file, fullPage: true });
      console.log(`Screenshot: ${file}`);
    } catch (err) {
      console.error(`Failed ${url} @ ${vp.name}: ${err.message}`);
    } finally {
      await context.close();
    }
  }
}

await browser.close();
