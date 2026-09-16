import { defineConfig, devices } from "playwright/test";

// Browser smoke tests run against the production build served by `next start`
// on a fixed local port. CI builds once (the `npm run build` step) and reuses
// that output here; locally `npm run test:smoke` builds first so the suite
// stays a single command.
const port = 3100;

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
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -p ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
