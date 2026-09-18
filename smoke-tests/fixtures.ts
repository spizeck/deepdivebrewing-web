import { test as base, expect } from "playwright/test";

/**
 * Extended test fixture shared by the smoke suite.
 *
 * External isolation — tests must not depend on third-party availability:
 * - Cross-origin requests (GA4/gtag, Firebase endpoints, fonts, …) are
 *   aborted. The suite never talks to production services.
 * - Same-origin `/_vercel/*` requests are fulfilled with an empty script.
 *   @vercel/analytics and @vercel/speed-insights inject script tags pointing
 *   at platform-only endpoints that 404 under a plain `next start`; stubbing
 *   them keeps the console clean without weakening the error checks.
 *
 * Runtime guards — collected during each test and asserted empty at
 * teardown, so any unexpected browser failure fails the test:
 * - `pageerror` events (uncaught exceptions)
 * - console messages of type `error`, minus a tiny documented tolerate list
 * - same-origin network failures (`requestfailed`)
 * - same-origin 4xx/5xx subresource responses (missing chunks, assets, API
 *   calls) and any 5xx document response. 4xx documents are excluded because
 *   the not-found test deliberately navigates to one and asserts its status.
 */
const TOLERATED_CONSOLE_ERRORS: RegExp[] = [
  // Chrome's generic network log line for failed subresources and error-status
  // documents. This fires for the cross-origin requests we deliberately abort
  // and for the intentional 404 navigation; same-origin failures are still
  // caught by the requestfailed/response listeners below, so nothing is lost.
  /^Failed to load resource:/,
  // Firebase Auth reports the missing client configuration that CI
  // intentionally omits. The /admin test asserts the visible "Sign-in is
  // currently unavailable." fallback, so the log adds no extra signal here.
  /^Firebase Auth is unavailable:/,
];

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const origin = new URL(testInfo.project.use.baseURL as string).origin;
    const problems: string[] = [];

    // The bundled Klaro consent notice appears for every undecided visitor.
    // Pre-seed a stored "decline optional" choice so it stays closed and can
    // never overlap interactive elements; consent tests clear cookies to see
    // the real notice. The value is Klaro's own storage format —
    // encodeURIComponent(JSON.stringify(consents)) under the app's
    // policy-versioned storage name (see lib/consent.ts).
    await page.context().addCookies([
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

    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname.startsWith("/_vercel/")) {
        return route.fulfill({
          status: 200,
          contentType: "application/javascript",
          body: "",
        });
      }
      return route.continue();
    });

    page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (
        msg.type() === "error" &&
        !TOLERATED_CONSOLE_ERRORS.some((re) => re.test(msg.text()))
      ) {
        problems.push(`console.error: ${msg.text()}`);
      }
    });
    page.on("requestfailed", (req) => {
      const url = new URL(req.url());
      if (url.origin !== origin) return;
      // Next.js cancels in-flight RSC/prefetch fetches when a link unmounts
      // or a newer navigation supersedes them — an expected abort, not a
      // failure. (Only reachable with real content data; CI's empty-state
      // build issues no such requests.)
      if (
        req.failure()?.errorText === "net::ERR_ABORTED" &&
        url.searchParams.has("_rsc")
      ) {
        return;
      }
      problems.push(
        `requestfailed: ${req.url()} (${req.failure()?.errorText ?? "?"})`
      );
    });
    page.on("response", (res) => {
      if (new URL(res.url()).origin !== origin) return;
      const isDocument = res.request().resourceType() === "document";
      const isProblem = isDocument ? res.status() >= 500 : res.status() >= 400;
      if (isProblem) {
        problems.push(`HTTP ${res.status()}: ${res.url()}`);
      }
    });

    // eslint-disable-next-line react-hooks/rules-of-hooks -- Playwright fixture yield, not a React hook
    await use(page);
    expect(problems, "unexpected browser/runtime failures").toEqual([]);
  },
});

export { expect };
