// Browser-side Sentry init (Issue #92). Next.js runs this once on the client
// before hydration. Privacy boundary mirrors the server: no PII attachment,
// no tracing, no Session Replay (never added to integrations), and the
// Breadcrumbs integration is removed entirely so console/UI/network crumbs
// are never collected rather than scrubbed after the fact. BrowserSession —
// the v10 default integration that emits release-health session envelopes on
// page idle/hide and route change — is also removed: this app sends error
// events only, with no background telemetry between exceptions. beforeSend
// strips the page URL query, headers, user context, and frame locals
// regardless.
import * as Sentry from "@sentry/nextjs";
import { clientMonitoringEnabled, scrubEvent } from "./lib/monitoring-shared";

// NOTE: Next.js inlines only direct `process.env.NEXT_PUBLIC_*` property
// accesses into the client bundle — a bare `process.env` object is not
// populated in the browser. Build the gate input from literal accesses so
// the production check actually sees the values.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: clientMonitoringEnabled({
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
  }),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
  sendDefaultPii: false,
  tracesSampleRate: 0,
  maxBreadcrumbs: 0,
  integrations: (integrations) =>
    integrations.filter(
      (integration) =>
        integration.name !== "Breadcrumbs" &&
        // Release-health session tracking is opt-out via the integration,
        // not an option — there is no `autoSessionTracking` in SDK v10.
        integration.name !== "BrowserSession"
    ),
  beforeSend: (event) =>
    scrubEvent(
      event as unknown as Record<string, unknown>
    ) as unknown as typeof event,
});

// Standard App Router hook the Sentry SDK looks for; it only records
// navigation spans when tracing is enabled, so it is a no-op here.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
