import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ headless: true });

const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

await page.goto(`${baseUrl}/trade`, { waitUntil: "networkidle", timeout: 15000 });

// Expose a small helper to read the dataLayer after clicks.
const eventNames = await page.evaluate(() => {
  return new Promise((resolve) => {
    const names = [];
    const originalPush = window.dataLayer?.push;
    if (originalPush) {
      window.dataLayer.push = function (...args) {
        const event = args[0];
        if (event && event.event) names.push(event.event);
        return originalPush.apply(this, args);
      };
    }
    setTimeout(() => resolve(names), 500);
  });
});

console.log("Trade page initial analytics events:", eventNames);

await page.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(500);

await page.evaluate(() => {
  window.capturedEvents = [];
  const originalPush = window.dataLayer.push;
  window.dataLayer.push = function (...args) {
    const event = args[0];
    if (event && event.event) window.capturedEvents.push({ name: event.event, params: event });
    return originalPush.apply(this, args);
  };
});

const tourButton = page.locator('a:has-text("Book a Brewery Tour")').first();
if (await tourButton.count() > 0) {
  await tourButton.click();
  await page.waitForTimeout(300);
  const captured = await page.evaluate(() => window.capturedEvents);
  console.log("Captured after tour click:", JSON.stringify(captured, null, 2));
}

await context.close();
await browser.close();
