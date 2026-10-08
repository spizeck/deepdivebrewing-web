import { chromium } from "playwright";
import { mkdir } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "screenshots");
await mkdir(outDir, { recursive: true });

const baseUrl = process.env.BASE_URL ?? "http://localhost:3111";
const origin = new URL(baseUrl).origin;
const shots = [
  { path: "/updates", name: "updates-archive" },
  { path: "/updates/brew-day-at-fort-bay", name: "updates-detail" },
  { path: "/", name: "home-updates-teaser" },
];
const viewports = [
  { width: 1280, height: 900, name: "desktop" },
  { width: 390, height: 844, name: "mobile" },
];

const browser = await chromium.launch({ headless: true });
for (const shot of shots) {
  for (const vp of viewports) {
    const context = await browser.newContext({ viewport: vp });
    // Decline-analytics consent cookie so the Klaro notice stays closed.
    await context.addCookies([
      {
        name: "ddb-consent-v1",
        value: encodeURIComponent(
          JSON.stringify({
            "consent-preferences": true,
            "google-analytics": false,
          })
        ),
        url: origin,
      },
    ]);
    const p = await context.newPage();
    try {
      await p.goto(`${baseUrl}${shot.path}`, {
        waitUntil: "networkidle",
        timeout: 20000,
      });
      // Scroll through the page so IntersectionObserver-driven reveals run,
      // then settle back at the top before the capture.
      await p.evaluate(async () => {
        const step = window.innerHeight * 0.8;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        window.scrollTo(0, 0);
      });
      await p.waitForTimeout(800);
      const file = join(outDir, `${shot.name}-${vp.name}.png`);
      await p.screenshot({ path: file, fullPage: true });
      console.log(`Screenshot: ${file}`);
    } catch (err) {
      console.error(`Failed ${shot.path} @ ${vp.name}: ${err.message}`);
    } finally {
      await context.close();
    }
  }
}
await browser.close();
