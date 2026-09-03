import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const errors = [];
const csp = [];
page.on("console", (msg) => {
  const text = msg.text();
  if (msg.type() === "error") errors.push(text);
  if (/CSP|Content Security Policy|violate/i.test(text)) csp.push(text);
});
page.on("pageerror", (err) => errors.push(err.message));

await page.goto(`${baseUrl}/admin`, { waitUntil: "networkidle", timeout: 20000 });
await page.waitForTimeout(2000);

console.log("CSP issues:", csp);
console.log("Errors:", errors);

await context.close();
await browser.close();
