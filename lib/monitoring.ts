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
// Event name used for uncaught server errors reported via instrumentation's
// onRequestError hook. Unlike curated logError events it is deliberately
// NOT fingerprinted — distinct exceptions must form distinct Sentry issues.
const REQUEST_ERROR_EVENT = "next.request_error";
const MAX_ERROR_TEXT_LENGTH = 300;

// Mirrors the defensive key filter in lib/log.ts — duplicated here (rather
// than imported) to keep this module free of a runtime dependency on the
// logging module it is called from.
const SENSITIVE_KEY =
  /authorization|cookie|token|secret|password|credential|private|api[-_]?key|deploy[-_]?hook/i;

// Scrubs sensitive material out of free-text error content (exception
// messages, error names, stack lines) before it can leave the process.
// Provider and runtime exceptions are uncontrolled text: they can embed
// emails, bearer tokens, URLs with query params, API keys, or customer
// values. Bounded to keep Sentry payloads small.
export function sanitizeErrorText(text: string): string {
  const sanitized = text
    // URLs: keep origin + path (route-level diagnosis), drop query/fragment
    // where customer values actually live.
    .replace(
      /https?:\/\/[^\s"'<>()[\]]+/g,
      (url) => url.split(/[?#]/)[0]
    )
    // Bearer / authorization tokens.
    .replace(/\b(bearer|authorization)\s+[^\s"'<>]+/gi, "$1 [redacted]")
    // Email addresses.
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
    // key=value / key: value secrets (api_key, token, secret, …).
    .replace(
      /\b(api[-_]?key|token|secret|password|credential|deploy[-_]?hook)\s*[=:]\s*[^\s"'<>]+/gi,
      "$1=[redacted]"
    )
    // JWTs (three base64url segments starting with eyJ).
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted]")
    // Other long opaque tokens/keys/ids — a 32+ char unbroken run is never
    // a human-readable word worth preserving.
    .replace(/\b[\w-]{32,}\b/g, "[redacted]");
  return sanitized.length > MAX_ERROR_TEXT_LENGTH
    ? `${sanitized.slice(0, MAX_ERROR_TEXT_LENGTH)}…`
    : sanitized;
}

// Produces the error representation sent to Sentry. The raw exception is
// never forwarded: its message, name, and stack can carry customer data or
// secrets, while Vercel logs already keep the full detail for operators.
//
// Stacks are preserved (with the same text scrubbing applied per line):
// V8 stack frames are file paths, function names, and line:column — not
// runtime values — so they stay useful for grouping/diagnosis. The stack's
// first line embeds the raw message, so it is rebuilt from the sanitized
// parts rather than kept verbatim.
export function sanitizeError(error: unknown): Error {
  const source =
    error instanceof Error || (typeof error === "object" && error !== null)
      ? (error as Error & { code?: unknown; statusCode?: unknown })
      : null;

  const name = sanitizeErrorText(
    String(source?.name || "Error")
  ).slice(0, 100);
  const message = sanitizeErrorText(
    source ? String(source.message ?? error) : String(error)
  );
  const code = source?.code ?? source?.statusCode;

  const safe = new Error(message);
  safe.name = name;
  if (code !== undefined && (typeof code === "string" || typeof code === "number")) {
    (safe as Error & { code?: string }).code = String(code);
  }

  if (source?.stack) {
    // Rebuild: first line from sanitized name+message, frame lines scrubbed
    // individually (frames are paths/functions, but they are still
    // uncontrolled text — e.g. eval'd code names).
    const frames = source.stack
      .split("\n")
      .slice(1)
      .filter((line) => line.trimStart().startsWith("at "))
      .map((line) => sanitizeErrorText(line));
    safe.stack = [`${name}: ${message}`, ...frames].join("\n");
  }

  return safe;
}

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

  // Defense in depth: exceptions are sanitized before capture, but scrub the
  // serialized values here too in case a future capture path bypasses
  // sanitizeError.
  const exception = scrubbed.exception;
  if (exception && typeof exception === "object") {
    const values = (exception as { values?: unknown }).values;
    if (Array.isArray(values)) {
      for (const value of values) {
        if (value && typeof value === "object") {
          const v = value as { type?: unknown; value?: unknown };
          if (typeof v.type === "string") v.type = sanitizeErrorText(v.type);
          if (typeof v.value === "string") v.value = sanitizeErrorText(v.value);
        }
      }
    }
  }

  return scrubbed;
}

// Fingerprint policy: curated logError events get a stable event-name
// fingerprint so all occurrences of one failure class group into a single
// Sentry issue (alert-once semantics). Uncaught request errors get NO custom
// fingerprint — Sentry's normal exception grouping (type + sanitized stack)
// must distinguish genuinely different failures; only the `event` tag is
// shared for filtering. Never fingerprint on request URLs, query strings,
// customer values, or other high-cardinality/user-controlled data.
export function fingerprintForEvent(event: string): string[] | undefined {
  return event === REQUEST_ERROR_EVENT
    ? undefined
    : ["deepdivebrewing", event];
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

// Uncaught server errors (render, RSC, route handlers) arrive here from
// instrumentation.ts's onRequestError hook — they bypass logError, so this
// is their reporting path. Only path/method/route info is attached; request
// headers/cookies/body are deliberately never touched.
export function reportRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routerKind?: string; routePath?: string; routeType?: string }
): void {
  reportError(REQUEST_ERROR_EVENT, error, {
    // Path is user-controlled text — scrub it like exception content.
    path: sanitizeErrorText(request.path),
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
