import { chromium } from "playwright";

const baseUrl = process.env.PREVIEW_URL ?? "https://deepdivebrewing-7uytzsc5a-chad-nuttalls-projects.vercel.app";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const errors = [];
const warnings = [];
const cspViolations = [];

page.on("console", (msg) => {
  const text = msg.text();
  if (msg.type() === "error") errors.push(text);
  if (msg.type() === "warning") warnings.push(text);
  if (/Content Security Policy/i.test(text) || /violates.*CSP/i.test(text)) {
    cspViolations.push(text);
  }
});

page.on("pageerror", (err) => errors.push(err.message));

// Check /admin loads and captures any CSP/script errors.
await page.goto(`${baseUrl}/admin`, { waitUntil: "networkidle", timeout: 20000 });
await page.waitForTimeout(2000);

// Try to find and click the Google sign-in button/iframe.
const googleButtonSelectors = [
  '[data-testid="google-signin"]',
  'button:has-text("Google")',
  'button:has-text("Sign in with Google")',
  'button:has-text("Continue with Google")',
  'iframe[title*="Sign in with Google"]',
  'iframe[src*="accounts.google.com"]',
];

let clicked = false;
for (const sel of googleButtonSelectors) {
  try {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      await el.click({ timeout: 5000 });
      clicked = true;
      console.log(`Clicked Google sign-in element: ${sel}`);
      break;
    }
  } catch (e) {
    // ignore
  }
}

if (!clicked) {
  console.log("No Google sign-in element found to click.");
}

// Wait for any iframe / popup / network activity.
await page.waitForTimeout(3000);

// Check if a popup opened.
const popup = await page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
if (popup) {
  console.log("Google sign-in popup opened.");
  const popupErrors = [];
  popup.on("console", (msg) => { if (msg.type() === "error") popupErrors.push(msg.text()); });
  popup.on("pageerror", (err) => popupErrors.push(err.message));
  await popup.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  console.log("Popup errors:", popupErrors);
  await popup.close().catch(() => {});
}

console.log("--- /admin CSP violations ---");
cspViolations.forEach((v) => console.log(v));

console.log("--- /admin console errors ---");
errors.forEach((e) => console.log(e));

console.log("--- /admin warnings ---");
warnings.forEach((w) => console.log(w));

// Check /contact map.
const contactPage = await context.newPage();
const contactErrors = [];
contactPage.on("console", (msg) => { if (msg.type() === "error") contactErrors.push(msg.text()); });
contactPage.on("pageerror", (err) => contactErrors.push(err.message));
await contactPage.goto(`${baseUrl}/contact`, { waitUntil: "networkidle", timeout: 20000 });
await contactPage.waitForTimeout(3000);

const mapFrame = contactPage.locator('iframe[src*="google.com/maps"]').first();
const mapVisible = await mapFrame.isVisible().catch(() => false);
console.log(`Contact map iframe visible: ${mapVisible}`);
console.log("Contact page errors:", contactErrors);

await context.close();
await browser.close();
