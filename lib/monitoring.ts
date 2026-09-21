// Production error monitoring (Issues #85, #92): the curated server funnel.
//
// Architecture:
// - `lib/log.ts`'s `logError` is the curated funnel — every actionable
//   failure event already flows through it (trade_inquiry.*_failed,
//   admin_*_failed, unexpected route errors, misconfigurations), while
//   routine 4xx/validation/denial paths never call it. `write()` reports
//   error-level lines here, so all current and future `logError` call sites
//   are covered without per-route wiring.
// - `instrumentation.ts` `register()` loads `sentry.server.config.ts`
//   (nodejs runtime) which runs `Sentry.init`; `instrumentation-client.ts`
//   initializes the browser SDK. `onRequestError` delegates to
//   `Sentry.captureRequestError` so uncaught server render/route errors
//   (which bypass logError) reach Sentry with full request context —
//   sanitized by the shared `beforeSend` (`scrubEvent` in
//   `lib/monitoring-shared.ts`).
// - `next.config.ts` wraps the config with `withSentryConfig` for release
//   and source-map upload (build-time, Production only).
//
// Hard guarantees:
// - Disabled unless VERCEL_ENV=production AND a DSN is set; preview, dev,
//   CI, and credential-free builds can never emit events. The `enabled`
//   flag (not "don't init") keeps stray capture calls silent no-ops.
// - Never throws and never blocks a request: reporting is fire-and-forget,
//   every failure is swallowed, and the flush is bounded. A Sentry outage
//   cannot affect customer or admin workflows.
// - Privacy: sendDefaultPii=false and scrubEvent strips request headers,
//   cookies, bodies, user context, query strings, breadcrumbs, and frame
//   locals from every event — on server and browser alike.
import type { LogContext, LogContextValue } from "@/lib/log";
import { monitoringEnabled, sanitizeError } from "@/lib/monitoring-shared";

// Re-exported so existing imports/tests keep working — the canonical home
// for these helpers is monitoring-shared (shared with the browser bundle).
export {
  clientMonitoringEnabled,
  monitoringEnabled,
  sanitizeError,
  sanitizeErrorText,
  scrubEvent,
  sentryDsn,
} from "@/lib/monitoring-shared";

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

// Fingerprint policy: curated logError events get a stable event-name
// fingerprint so all occurrences of one failure class group into a single
// Sentry issue (alert-once semantics). Uncaught request errors reported via
// onRequestError get NO custom fingerprint — Sentry's normal exception
// grouping must keep genuinely different failures distinct. Never
// fingerprint on request URLs, query strings, customer values, or other
// high-cardinality/user-controlled data.
export function fingerprintForEvent(event: string): string[] {
  return ["deepdivebrewing", event];
}

async function deliver(payload: MonitorPayload): Promise<void> {
  const sentry = await getSentry();
  if (!sentry) return;

  const hint = {
    fingerprint: fingerprintForEvent(payload.event),
    tags: { event: payload.event },
    extra: payload.context,
  };
  if (payload.error !== undefined) {
    // payload.error is already the sanitized synthetic Error from
    // reportError — the raw exception never leaves the process.
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
      // Reduce to a sanitized synthetic Error here so every downstream path
      // (delivery, test observation) sees only the safe representation.
      error: error !== undefined ? sanitizeError(error) : undefined,
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
