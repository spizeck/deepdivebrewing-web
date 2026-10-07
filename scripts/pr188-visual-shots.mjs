// Local diagnostic (not CI): captures the PR #188 visual-review artifacts —
// grain vs brewhouse hero at three widths, desktop brand-pill variants, and
// the mobile menu's expanded-body opacity over photo and light pages.
// Run against a production server:
//   npx next start -p 3100
//   node scripts/pr188-visual-shots.mjs
import { chromium } from "playwright";
import { mkdir } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "review-shots", "pr188");
const baseUrl = process.env.BASE_URL ?? "http://localhost:3100";

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });

async function shot(page, name) {
  const file = join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`shot: ${name}.png`);
}

// Swap the brewhouse hero for the grain asset and recenter it so the
// capture matches the pre-change hero exactly (same layout, real image).
async function routeGrainHero(page) {
  await page.route("**/_next/image*", (route) => {
    const url = new URL(route.request().url());
    const inner = url.searchParams.get("url") ?? "";
    if (inner.includes("herobrewhouse.jpg")) {
      url.searchParams.set("url", inner.replace("herobrewhouse.jpg", "herograin.jpg"));
      return route.continue({ url: url.toString() });
    }
    return route.continue();
  });
}

async function settleHero(page, width, height, { grain = false } = {}) {
  if (grain) await routeGrainHero(page);
  await page.setViewportSize({ width, height });
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  if (grain) {
    await page.evaluate(() => {
      const img = document.querySelector("section img");
      if (img) img.style.objectPosition = "50% 50%";
    });
    await page.waitForTimeout(200);
  }
}

// ---------- homepage hero: grain vs brewhouse ----------
for (const { width, height, tag } of [
  { width: 390, height: 844, tag: "390" },
  { width: 1280, height: 900, tag: "1280" },
  { width: 1600, height: 900, tag: "1600" },
]) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  await settleHero(page, width, height);
  await shot(page, `home-${tag}-brewhouse`);

  await settleHero(page, width, height, { grain: true });
  await shot(page, `home-${tag}-grain`);

  await context.close();
}

// ---------- desktop brand pill ----------
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await shot(page, "nav-1280-logo-pill");

  // Restore the prior full-wordmark composition for comparison: undo the
  // lg-only classes added in this pass. Computed result is identical to
  // the previous build's markup.
  await page.evaluate(() => {
    const span = document.querySelector("header a[href='/'] span");
    const link = document.querySelector("header a[href='/']");
    const pill = link?.parentElement;
    span?.classList.remove("lg:sr-only");
    link?.classList.remove("lg:w-11", "lg:justify-center", "lg:pr-0");
    pill?.classList.remove("lg:px-4");
    pill?.classList.add("lg:pl-4", "lg:pr-5");
  });
  await page.waitForTimeout(300);
  await shot(page, "nav-1280-wordmark-pill");
  await context.close();
}
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await shot(page, "nav-1600-logo-pill");
  await context.close();
}

// ---------- mobile menu opacity ----------
{
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const toggle = page.locator("button[aria-controls]");
  // Dispatch the click on the DOM node: actionability checks scroll the
  // button into view, which can trigger the pill's scroll retreat and put
  // the click point off-screen under page content.
  const openMenu = () => toggle.dispatchEvent("click");

  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await openMenu();
  await page.waitForTimeout(400);
  await shot(page, "menu-390-home-open");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await page.goto(`${baseUrl}/where-to-buy`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await openMenu();
  await page.waitForTimeout(400);
  await shot(page, "menu-390-where-to-buy-open");

  // before-state comparison: drop the panel back to 85% ink
  await page.evaluate(() => {
    const panel = document.querySelector('nav[aria-label="Mobile"]');
    panel?.classList.remove("bg-ink");
    panel?.classList.add("bg-ink/85");
  });
  await page.waitForTimeout(300);
  await shot(page, "menu-390-where-to-buy-open-85");

  await context.close();
}

await browser.close();
console.log("done -> " + outDir);
