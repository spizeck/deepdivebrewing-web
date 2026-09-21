// Temporary screenshot helper for Issue #84 visual verification.
import { chromium } from "playwright";

const base = "http://localhost:3300";
const out = process.env.TEMP + "\\wtb";
const viewports = [
  ["desktop", 1440, 900],
  ["laptop", 1280, 800],
  ["tablet", 768, 1024],
  ["mobile", 375, 800],
  ["narrow", 320, 700],
];

const browser = await chromium.launch();
for (const [name, w, h] of viewports) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`${base}/where-to-buy-fixture`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${out}-${name}.png`, fullPage: true });
  // Filtered state
  await page.getByLabel("Beer", { exact: true }).selectOption("saba-suds-pilsner");
  await page.getByRole("button", { name: "On Tap", exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}-${name}-filtered.png`, fullPage: true });
  // Empty state
  await page.getByRole("button", { name: "In Can", exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}-${name}-empty.png`, fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  console.log(`${name} ${w}x${h} overflow=${overflow}`);
  await page.close();
}
await browser.close();
console.log("done ->", out);
