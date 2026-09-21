// Server-side Sentry init (Issue #92), loaded once per server start by
// instrumentation.ts register() under the nodejs runtime. All gates and
// sanitization live in lib/monitoring-shared.ts — enabled is false outside
// Vercel Production so preview/dev/CI capture calls are silent no-ops.
import * as Sentry from "@sentry/nextjs";
import {
  monitoringEnabled,
  scrubEvent,
  sentryDsn,
} from "./lib/monitoring-shared";

Sentry.init({
  dsn: sentryDsn(),
  enabled: monitoringEnabled(),
  environment: process.env.VERCEL_ENV ?? "development",
  release: process.env.VERCEL_GIT_COMMIT_SHA,
  // Privacy floor: no IP/user/cookie association, no performance tracing,
  // no breadcrumbs — we send curated failure events only.
  sendDefaultPii: false,
  tracesSampleRate: 0,
  maxBreadcrumbs: 0,
  integrations: (integrations) =>
    // ProcessSession — the node-core default that starts a session on init
    // and emits release-health session envelopes — is removed so no
    // background telemetry is sent between exceptions.
    integrations.filter(
      (integration) => integration.name !== "ProcessSession"
    ),
  beforeSend: (event) =>
    scrubEvent(
      event as unknown as Record<string, unknown>
    ) as unknown as typeof event,
});
