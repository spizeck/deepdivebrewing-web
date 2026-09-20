// Production error monitoring (Issue #85): server-side Sentry capture.
//
// Architecture:
// - `lib/log.ts`'s `logError` is the curated funnel — every actionable
//   failure event already flows through it (trade_inquiry.*_failed,
//   admin_*_failed, unexpected route errors, misconfigurations), while
//   routine 4xx/validation/denial paths never call it. `write()` reports
//   error-level lines here, so all current and future `logError` call sites
//   are covered without per-route wiring.
// - `instrumentation.ts` `onRequestError` reports uncaught server render /
//   route-handler errors (which bypass logError) via `reportRequestError`.
// - `initMonitoring` initializes the SDK from `instrumentation.ts`
//   `register()` — no `withSentryConfig`, no client bundle, no CSP changes:
//   the browser never talks to Sentry.
//
// Hard guarantees:
// - Disabled unless VERCEL_ENV=production AND SENTRY_DSN is set; preview,
//   dev, CI, and credential-free builds can never emit events.
// - Never throws and never blocks a request: reporting is fire-and-forget,
//   every failure is swallowed, and the flush is bounded. A Sentry outage
//   cannot affect customer or admin workflows.
// - Privacy: sendDefaultPii=false and scrubEvent strips request headers,
//   cookies, bodies, user context, and query strings from every event.
import type { LogContext, LogContextValue } from "@/lib/log";

const FLUSH_TIMEOUT_MS = 2000;

// Mirrors the defensive key filter in lib/log.ts — duplicated here (rather
// than imported) to keep this module free of a runtime dependency on the
// logging module it is called from.
const SENSITIVE_KEY =
  /authorization|cookie|token|secret|password|credential|private|api[-_]?key|deploy[-_]?hook/i;

interface MonitorPayload {
  event: string;
  error?: unknown;
  context?: Record<string, LogContextValue>;
}

// Minimal structural view of the SDK surface this module uses — keeps the
// module importable anywhere without pulling @sentry/nextjs into a bundle.
interface SentryLike {
  captureException(error: unknown, context?: Record<string, unknown>): string;
  captureMessage(message: string, context?: Record<string, unknown>): string;
  flush(timeout?: number): Promise<boolean>;
}

let sentryPromise: Promise<SentryLike | null> | null = null;

export function monitoringEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  // NEXT_RUNTIME is set only while serving requests — this also excludes
  // `next build`/prerender, where VERCEL_ENV=production on Vercel too.
  return (
    env.VERCEL_ENV === "production" &&
    env.NEXT_RUNTIME === "nodejs" &&
    Boolean(env.SENTRY_DSN)
  );
}

async function getSentry(): Promise<SentryLike | null> {
  sentryPromise ??= import("@sentry/nextjs")
    .then((mod) => mod as unknown as SentryLike)
    .catch(() => null);
  return sentryPromise;
}

function sanitizeContext(
  context: LogContext | undefined
): Record<string, LogContextValue> | undefined {
  if (!context) return undefined;
  const safe: Record<string, LogContextValue> = {};
  for (const [key, value] of Object.entries(context)) {
    if (SENSITIVE_KEY.test(key) || value === undefined) continue;
    safe[key] = value;
  }
  return safe;
}

// Strips anything a Sentry SDK may attach that this app's privacy rules
// forbid: request headers/cookies/body (auth tokens, inquiry contents),
// user context, query strings, and breadcrumbs. Applied as `beforeSend` in
// initMonitoring and kept pure so unit tests can exercise it directly.
export function scrubEvent(
  event: Record<string, unknown>
): Record<string, unknown> {
  const scrubbed = { ...event };

  delete scrubbed.user;
  delete scrubbed.breadcrumbs;

  const request = scrubbed.request;
  if (request && typeof request === "object") {
    const req = { ...(request as Record<string, unknown>) };
    delete req.headers;
    delete req.cookies;
    delete req.data;
    delete req.query_string;
    if (typeof req.url === "string") {
      // Keep origin + path; drop the query/fragment (can carry form params).
      req.url = req.url.split("?")[0].split("#")[0];
    }
    scrubbed.request = req;
  }

  const extra = scrubbed.extra;
  if (extra && typeof extra === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(extra)) {
      if (!SENSITIVE_KEY.test(key)) clean[key] = value;
    }
    scrubbed.extra = clean;
  }

  return scrubbed;
}

async function deliver(payload: MonitorPayload): Promise<void> {
  const sentry = await getSentry();
  if (!sentry) return;

  const hint = {
    // Fingerprint on the stable event name: every occurrence of a failure
    // mode groups into one issue, so Sentry alerts fire once per new failure
    // class rather than once per occurrence.
    fingerprint: ["deepdivebrewing", payload.event],
    tags: { event: payload.event },
    extra: payload.context,
  };
  if (payload.error !== undefined) {
    sentry.captureException(payload.error, hint);
  } else {
    sentry.captureMessage(payload.event, { level: "error", ...hint });
  }

  // Serverless functions freeze once the response is sent; `after()` keeps
  // the flush alive past the response so the event is actually delivered.
  // Outside a request scope `after` throws — fall back to an inline flush.
  let scheduled = false;
  try {
    const { after } = await import("next/server");
    after(() => {
      void sentry.flush(FLUSH_TIMEOUT_MS);
    });
    scheduled = true;
  } catch {
    // No request context (e.g. build-time) — flush inline below.
  }
  if (!scheduled) {
    await sentry.flush(FLUSH_TIMEOUT_MS);
  }
}

// Test seam: lets unit tests observe reported payloads without importing
// the SDK or touching the network. Never set in production code.
let reporterForTests: ((payload: MonitorPayload) => void) | null = null;
export function __setReporterForTests(
  reporter: ((payload: MonitorPayload) => void) | null
): void {
  reporterForTests = reporter;
}

export function reportError(
  event: string,
  error?: unknown,
  context?: LogContext
): void {
  try {
    const payload: MonitorPayload = {
      event,
      error,
      context: sanitizeContext(context),
    };
    if (reporterForTests) {
      reporterForTests(payload);
      return;
    }
    if (!monitoringEnabled()) return;
    void deliver(payload).catch(() => {
      // Reporting must never surface into the request path.
    });
  } catch {
    // Reporting must never surface into the request path.
  }
}

// Uncaught server errors (render, RSC, route handlers) arrive here from
// instrumentation.ts's onRequestError hook — they bypass logError, so this
// is their reporting path. Only path/method/route info is attached; request
// headers/cookies/body are deliberately never touched.
export function reportRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routerKind?: string; routePath?: string; routeType?: string }
): void {
  reportError("next.request_error", error, {
    path: request.path,
    method: request.method,
    routerKind: context.routerKind ?? null,
    routePath: context.routePath ?? null,
    routeType: context.routeType ?? null,
  });
}

export async function initMonitoring(): Promise<void> {
  try {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      // `enabled` (not "don't init") so capture calls in preview/dev/CI are
      // silent no-ops rather than SDK warnings.
      enabled: monitoringEnabled(),
      environment: process.env.VERCEL_ENV ?? "development",
      release: process.env.VERCEL_GIT_COMMIT_SHA,
      // Privacy floor: no IP/user/cookie association, no performance
      // tracing, no breadcrumbs — we send curated failure events only.
      sendDefaultPii: false,
      tracesSampleRate: 0,
      maxBreadcrumbs: 0,
      beforeSend: (event) =>
        scrubEvent(
          event as unknown as Record<string, unknown>
        ) as unknown as typeof event,
    });
  } catch {
    // Monitoring must never break application startup.
  }
}
