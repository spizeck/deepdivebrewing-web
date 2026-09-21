import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

// Static invariants for the Sentry architecture (Issue #92). These files are
// config/boundary code that a unit test cannot import meaningfully (client
// init would run Sentry.init; next.config executes build plugins), so we
// assert on the source — the same approach monitoring-test.test.ts uses for
// the verification route.
const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), ...rel.split("/")), "utf8");

const clientConfig = read("instrumentation-client.ts");
const serverConfig = read("sentry.server.config.ts");
const instrumentation = read("instrumentation.ts");
const nextConfig = read("next.config.ts");
const globalError = read("app/global-error.tsx");
const routeError = read("app/error.tsx");

describe("Sentry init boundaries", () => {
  it("client init exists, is DSN-driven, and stays privacy-minimal", () => {
    assert.ok(clientConfig.includes("Sentry.init"));
    assert.ok(clientConfig.includes("NEXT_PUBLIC_SENTRY_DSN"));
    assert.ok(clientConfig.includes("clientMonitoringEnabled"));
    // The gate must receive an explicit env object built from direct
    // process.env.NEXT_PUBLIC_* accesses — only those are inlined into the
    // client bundle; a bare process.env default is empty in the browser and
    // would silently disable client reporting.
    assert.ok(clientConfig.includes("clientMonitoringEnabled({"));
    assert.ok(
      clientConfig.includes(
        "NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV"
      )
    );
    assert.ok(clientConfig.includes("sendDefaultPii: false"));
    assert.ok(clientConfig.includes("tracesSampleRate: 0"));
    assert.ok(clientConfig.includes("scrubEvent"));
    // No Session Replay, profiling, or broad tracing — none of the API
    // surface for those features may appear in the client config.
    for (const forbidden of [
      "replayIntegration",
      "SessionReplay",
      "replaySessionSampleRate",
      "replayOnErrorSampleRate",
      "profileSessionSampleRate",
      "browserTracingIntegration",
      "SENTRY_AUTH_TOKEN",
      "authToken",
    ]) {
      assert.ok(
        !clientConfig.includes(forbidden),
        `client config must not contain ${forbidden}`
      );
    }
  });

  it("server init is DSN-driven, production-gated, and privacy-minimal", () => {
    assert.ok(serverConfig.includes("Sentry.init"));
    assert.ok(serverConfig.includes("monitoringEnabled"));
    assert.ok(serverConfig.includes("sendDefaultPii: false"));
    assert.ok(serverConfig.includes("tracesSampleRate: 0"));
    assert.ok(serverConfig.includes("scrubEvent"));
    for (const forbidden of [
      "replayIntegration",
      "SessionReplay",
      "profileSessionSampleRate",
    ]) {
      assert.ok(
        !serverConfig.includes(forbidden),
        `server config must not contain ${forbidden}`
      );
    }
  });

  it("removes the default session/release-health integrations on both runtimes", () => {
    // SDK v10 has no `autoSessionTracking` option — release-health session
    // envelopes come from default integrations: BrowserSession (browser)
    // emits on idle/hide and route change, ProcessSession (node) starts a
    // session at init. Both are filtered out so Sentry receives error events
    // only, with no background telemetry between exceptions.
    assert.ok(clientConfig.includes('integration.name !== "BrowserSession"'));
    assert.ok(serverConfig.includes('integration.name !== "ProcessSession"'));
    // Guard against reintroducing the removed option from older examples —
    // it would be a silent no-op. Match only actual option usage (with a
    // colon/assignment), not prose mentions in comments.
    for (const src of [clientConfig, serverConfig]) {
      assert.ok(!src.includes("autoSessionTracking:"));
      assert.ok(!src.includes("autoSessionTracking ="));
    }
  });

  it("server register() loads the server config under the nodejs runtime", () => {
    assert.ok(instrumentation.includes('NEXT_RUNTIME === "nodejs"'));
    assert.ok(instrumentation.includes("sentry.server.config"));
    // Uncaught request errors go through the SDK's supported capture path.
    assert.ok(instrumentation.includes("captureRequestError"));
  });

  it("error boundaries report to Sentry", () => {
    assert.ok(globalError.includes("Sentry.captureException"));
    assert.ok(routeError.includes("Sentry.captureException"));
    // global-error must render its own document shell.
    assert.ok(globalError.includes("<html"));
    assert.ok(globalError.includes("<body"));
  });
});

describe("Sentry build configuration", () => {
  it("wraps the config with the supported withSentryConfig entrypoint", () => {
    assert.ok(nextConfig.includes("@sentry/nextjs/config"));
    assert.ok(nextConfig.includes("withSentryConfig"));
  });

  it("reads org/project/auth token from the environment, never literals", () => {
    assert.ok(nextConfig.includes("process.env.SENTRY_ORG"));
    assert.ok(nextConfig.includes("process.env.SENTRY_PROJECT"));
    assert.ok(nextConfig.includes("process.env.SENTRY_AUTH_TOKEN"));
    // Org/project slugs and tokens must never be hard-coded.
    assert.ok(!nextConfig.includes("sea-saba"));
    assert.ok(!nextConfig.includes("deepdivebrewing-web.ingest"));
  });

  it("keeps source-map upload gated on the auth token and deletes maps after upload", () => {
    assert.ok(nextConfig.includes("sourcemaps"));
    assert.ok(nextConfig.includes("deleteSourcemapsAfterUpload: true"));
    // Upload disabled entirely without the token — CI/preview stay inert.
    assert.ok(
      nextConfig.includes("disable: !process.env.SENTRY_AUTH_TOKEN")
    );
  });
});

describe("CSP stays narrow", () => {
  it("permits only the ingest origin derived from the configured DSN", () => {
    // The connect-src entry is built from the DSN origin — no wildcard
    // sentry.io hostnames are hard-coded anywhere.
    assert.ok(!nextConfig.includes("*.sentry.io"));
    assert.ok(!nextConfig.includes("*.ingest.sentry.io"));
    assert.ok(!nextConfig.includes("*.ingest.us.sentry.io"));
    assert.ok(nextConfig.includes("NEXT_PUBLIC_SENTRY_DSN"));
    assert.ok(nextConfig.includes("sentryIngestOrigin"));
  });
});

describe("monitoring modules stay free of build credentials", () => {
  it("no runtime monitoring module references the auth token", () => {
    for (const file of [
      "lib/monitoring.ts",
      "lib/monitoring-shared.ts",
      "instrumentation-client.ts",
      "sentry.server.config.ts",
    ]) {
      const src = read(file);
      assert.ok(
        !src.includes("SENTRY_AUTH_TOKEN"),
        `${file} must not reference the auth token`
      );
    }
  });
});
