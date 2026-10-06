import { chromium } from "playwright";
import { mkdir } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Local diagnostic (not CI): slows the mobile menu transition ~8x via
// injected CSS so intermediate frames can be inspected, then captures a
// real-time burst for actual pacing. Run against a production server:
//   npx next start -p 3100
//   node scripts/menu-animation-frames.mjs
const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "review-shots", "menu-anim");
const baseUrl = process.env.BASE_URL ?? "http://localhost:3100";
const widths = [320, 390, 430];

const browser = await chromium.launch({ headless: true });

for (const width of widths) {
  const dir = join(outDir, `w${width}`);
  await mkdir(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width, height: 800 },
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/beers`, { waitUntil: "networkidle" });
  const toggle = page.locator("button[aria-controls]");
  const panel = page.locator('nav[aria-label="Mobile"]');

  async function burst(label, action, count, gapMs) {
    await action();
    for (let i = 0; i < count; i++) {
      await page.screenshot({
        path: join(dir, `${label}-f${String(i).padStart(2, "0")}.png`),
      });
      if (gapMs) await page.waitForTimeout(gapMs);
    }
  }

  // --- slowed transition: reveal the motion path ---
  await page.addStyleTag({
    content:
      'nav[aria-label="Mobile"] { transition-duration: 1.4s !important; }',
  });
  await burst("slow-open", () => toggle.click(), 12, 130);
  await burst("slow-close", () => toggle.click(), 12, 130);

  // --- real-time burst (reload drops the injected override) ---
  await page.reload({ waitUntil: "networkidle" });
  await burst("rt-open", () => toggle.click(), 6, 40);
  await burst("rt-close", () => toggle.click(), 6, 40);

  await context.close();
  console.log(`w${width} done`);
}
await browser.close();
console.log("done");
