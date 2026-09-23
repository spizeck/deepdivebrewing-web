import { defineConfig, devices } from "playwright/test";

// Browser smoke tests run against the production build served by `next start`
// on a fixed local port. CI builds once (the `npm run build` step) and reuses
// that output here; locally `npm run test:smoke` builds first so the suite
// stays a single command.
// DDB_SMOKE_PORT lets local runs sidestep unrelated dev servers already
// bound to the default port; CI always uses 3100.
const port = Number(process.env.DDB_SMOKE_PORT ?? 3100);

export default defineConfig({
  testDir: "./smoke-tests",
  // The suite is deterministic; a failure means a real problem, not a flake
  // to retry away.
  retries: 0,
  timeout: 30_000,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Simulate TLS: production requests always arrive with
    // x-forwarded-proto=https. On plain-HTTP `next start`, paths that match
    // a static route pattern but were not generated (dynamicParams=false)
    // re-dispatch internally as proto=http and hit the canonical
    // HTTP→HTTPS redirect in next.config.ts — sending browsers to the real
    // production domain mid-test. Declaring https keeps misses local.
    extraHTTPHeaders: { "x-forwarded-proto": "https" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -p ${port}`,
    url: `http://localhost:${port}`,
    // Enables /admin-fixture, /carousel-fixture, and /where-to-buy-fixture —
    // test-only routes that render real components with fixture data. Checked
    // server-side per request; absent everywhere else the routes 404. Note:
    // when running locally against an already-running server
    // (reuseExistingServer), the fixtures only exist if that server was
    // started with these env vars.
    env: {
      ADMIN_A11Y_FIXTURE: "1",
      CAROUSEL_FIXTURE: "1",
      WHERE_TO_BUY_FIXTURE: "1",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
