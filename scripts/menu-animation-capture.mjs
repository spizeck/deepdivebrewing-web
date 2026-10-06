import { chromium } from "playwright";
import { mkdir, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Local diagnostic (not CI): captures the mobile menu open/close animation
// frame-by-frame via a CDP screencast, plus a session video per viewport.
// Run against a production server:
//   npx next start -p 3100
//   node scripts/menu-animation-capture.mjs
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
    recordVideo: { dir, size: { width, height: 800 } },
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await page.goto(`${baseUrl}/beers`, { waitUntil: "networkidle" });

  const toggle = page.locator("button[aria-controls]");

  // --- capture helper: N screencast frames during an action ---
  async function captureDuring(label, action, settleMs = 600) {
    const frames = [];
    cdp.on("Page.screencastFrame", onFrame);
    async function onFrame({ data, metadata }) {
      frames.push({ data, ts: metadata.timestamp });
      cdp.send("Page.screencastFrameAck", { sessionId: metadata.sessionId }).catch(() => {});
    }
    await cdp.send("Page.startScreencast", {
      format: "png",
      everyNthFrame: 1,
    });
    await action();
    await page.waitForTimeout(settleMs);
    await cdp.send("Page.stopScreencast");
    cdp.off("Page.screencastFrame", onFrame);
    for (let i = 0; i < frames.length; i++) {
      await writeFile(
        join(dir, `${label}-f${String(i).padStart(3, "0")}.png`),
        Buffer.from(frames[i].data, "base64")
      );
    }
    console.log(`w${width} ${label}: ${frames.length} frames`);
  }

  // open via toggle
  await captureDuring("open", () => toggle.click());
  // close via toggle
  await captureDuring("close-toggle", () => toggle.click());
  // open again, close via Escape
  await captureDuring("open2", () => toggle.click());
  await captureDuring("close-escape", () => page.keyboard.press("Escape"));
  // open, close via link click (route change)
  await captureDuring("open3", () => toggle.click());
  await captureDuring("close-link", () =>
    page.locator('nav[aria-label="Mobile"] a[href="/about"]').click()
  );
  await page.goto(`${baseUrl}/beers`, { waitUntil: "domcontentloaded" });
  // rapid open -> close
  await captureDuring("rapid", async () => {
    await toggle.click();
    await page.waitForTimeout(120);
    await toggle.click();
  });

  await context.close(); // flushes video
}
await browser.close();
console.log("done");
