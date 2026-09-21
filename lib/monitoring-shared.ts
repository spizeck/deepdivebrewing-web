// Privacy sanitization and environment gating shared by the server and
// browser Sentry configurations (Issue #92). This module is imported by
// instrumentation-client.ts, so it must stay free of Node/server-only code
// (no next/server, no process-specific APIs beyond env reads at init).

const MAX_ERROR_TEXT_LENGTH = 300;

// Mirrors the defensive key filter in lib/log.ts — duplicated (rather than
// imported) so this module stays importable from browser bundles without
// pulling the logging module along.
const SENSITIVE_KEY =
  /authorization|cookie|token|secret|password|credential|private|api[-_]?key|deploy[-_]?hook/i;

/**
 * Scrubs sensitive material out of free-text error content (exception
 * messages, error names, stack lines) before it can leave the process.
 * Provider and runtime exceptions are uncontrolled text: they can embed
 * emails, bearer tokens, URLs with query params, API keys, or customer
 * values. Bounded to keep Sentry payloads small.
 */
export function sanitizeErrorText(text: string): string {
  const sanitized = text
    // URLs: keep origin + path (route-level diagnosis), drop query/fragment
    // where customer values actually live.
    .replace(/https?:\/\/[^\s"'<>()[\]]+/g, (url) => url.split(/[?#]/)[0])
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

/**
 * Produces the error representation sent to Sentry by the curated logError
 * funnel. The raw exception is never forwarded: its message, name, and stack
 * can carry customer data or secrets, while Vercel logs already keep the
 * full detail for operators.
 *
 * Stacks are preserved (with the same text scrubbing applied per line):
 * V8 stack frames are file paths, function names, and line:column — not
 * runtime values — so they stay useful for grouping/diagnosis. The stack's
 * first line embeds the raw message, so it is rebuilt from the sanitized
 * parts rather than kept verbatim.
 */
export function sanitizeError(error: unknown): Error {
  const source =
    error instanceof Error || (typeof error === "object" && error !== null)
      ? (error as Error & { code?: unknown; statusCode?: unknown })
      : null;

  const name = sanitizeErrorText(String(source?.name || "Error")).slice(
    0,
    100
  );
  const message = sanitizeErrorText(
    source ? String(source.message ?? error) : String(error)
  );
  const code = source?.code ?? source?.statusCode;

  const safe = new Error(message);
  safe.name = name;
  if (
    code !== undefined &&
    (typeof code === "string" || typeof code === "number")
  ) {
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

/**
 * The ingest DSN. `NEXT_PUBLIC_SENTRY_DSN` is the canonical variable — it is
 * inlined into the browser bundle at build time and read at runtime on the
 * server. `SENTRY_DSN` remains accepted during the Issue #92 cutover so the
 * previously configured variable keeps working until it is removed; drop
 * this fallback after production verification.
 */
export function sentryDsn(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return env.NEXT_PUBLIC_SENTRY_DSN ?? env.SENTRY_DSN;
}

/**
 * Server-side reporting gate. `NEXT_RUNTIME` is set only while serving
 * requests — this also excludes `next build`/prerender, where
 * VERCEL_ENV=production on Vercel too. The register() hook additionally
 * imports the server config only under the nodejs runtime.
 */
export function monitoringEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (
    env.VERCEL_ENV === "production" &&
    env.NEXT_RUNTIME === "nodejs" &&
    Boolean(sentryDsn(env))
  );
}

/**
 * Browser-side reporting gate. Vercel exposes NEXT_PUBLIC_VERCEL_ENV to the
 * client build automatically, so previews can never report even if the DSN
 * were ever scoped too broadly. Locally both vars are absent → inert; local
 * verification requires setting both explicitly (documented in
 * docs/operations/observability.md).
 */
export function clientMonitoringEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return (
    Boolean(env.NEXT_PUBLIC_SENTRY_DSN) &&
    env.NEXT_PUBLIC_VERCEL_ENV === "production"
  );
}

/**
 * Strips anything a Sentry SDK may attach that this app's privacy rules
 * forbid: request headers/cookies/body (auth tokens, inquiry contents),
 * user context, query strings, breadcrumbs, and stack-frame local variables.
 * Applied as `beforeSend` on both server and client init and kept pure so
 * unit tests can exercise it directly.
 */
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
      // Covers both server request URLs and the browser's location URL.
      req.url = req.url.split("?")[0].split("#")[0];
    }
    scrubbed.request = req;
  }

  // captureRequestError stores the request path under contexts.nextjs;
  // strip a query string if one ever appears there too.
  const contexts = scrubbed.contexts;
  if (contexts && typeof contexts === "object") {
    const cloned = { ...(contexts as Record<string, unknown>) };
    const nextjs = cloned.nextjs;
    if (nextjs && typeof nextjs === "object") {
      const ctx = { ...(nextjs as Record<string, unknown>) };
      if (typeof ctx.request_path === "string") {
        ctx.request_path = ctx.request_path.split("?")[0].split("#")[0];
      }
      cloned.nextjs = ctx;
    }
    scrubbed.contexts = cloned;
  }

  const extra = scrubbed.extra;
  if (extra && typeof extra === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(extra)) {
      if (!SENSITIVE_KEY.test(key)) clean[key] = value;
    }
    scrubbed.extra = clean;
  }

  // Defense in depth: exceptions are sanitized before capture on the curated
  // funnel, but SDK-captured errors (onRequestError, browser exceptions)
  // arrive raw — scrub the serialized values here either way.
  const exception = scrubbed.exception;
  if (exception && typeof exception === "object") {
    const values = (exception as { values?: unknown }).values;
    if (Array.isArray(values)) {
      for (const value of values) {
        if (value && typeof value === "object") {
          const v = value as {
            type?: unknown;
            value?: unknown;
            stacktrace?: unknown;
          };
          if (typeof v.type === "string") v.type = sanitizeErrorText(v.type);
          if (typeof v.value === "string")
            v.value = sanitizeErrorText(v.value);
          // Local variables attached to frames can embed customer values or
          // secrets — never let them leave, regardless of SDK settings.
          const stacktrace = v.stacktrace;
          if (stacktrace && typeof stacktrace === "object") {
            const frames = (stacktrace as { frames?: unknown }).frames;
            if (Array.isArray(frames)) {
              for (const frame of frames) {
                if (frame && typeof frame === "object") {
                  delete (frame as Record<string, unknown>).vars;
                }
              }
            }
          }
        }
      }
    }
  }

  return scrubbed;
}
