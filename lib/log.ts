// Structured operational logging for server-side code (API routes, admin
// helpers). Emits single-line JSON so Vercel's log search can filter on
// `level`/`event` reliably.
//
// Conventions:
// - `event` names are stable, lowercase, dot-namespaced
//   (e.g. "trade_inquiry.send_failed").
// - Context values are primitives only — never pass objects, request bodies,
//   or records. Keys that look sensitive (token, secret, key, hook, …) are
//   dropped defensively, but callers should simply never include them.
// - This module is intentionally dependency-free so it is safe to import
//   anywhere; it is designed for server-side use.
export type LogContextValue = string | number | boolean | null;
export type LogContext = Record<string, LogContextValue | undefined>;

const SENSITIVE_KEY =
  /authorization|cookie|token|secret|password|credential|private|api[-_]?key|deploy[-_]?hook/i;
const MAX_VALUE_LENGTH = 300;

function sanitizeContext(context: LogContext): Record<string, LogContextValue> {
  const safe: Record<string, LogContextValue> = {};
  for (const [key, value] of Object.entries(context)) {
    if (SENSITIVE_KEY.test(key) || value === undefined) continue;
    if (typeof value === "string" && value.length > MAX_VALUE_LENGTH) {
      safe[key] = `${value.slice(0, MAX_VALUE_LENGTH)}…`;
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

export interface NormalizedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
}

export function normalizeError(error: unknown): NormalizedError {
  // Error instances and provider error objects (e.g. Resend's
  // { name, message, statusCode }) are normalized the same way.
  if (error instanceof Error || isErrorLike(error)) {
    const err = error as Error & { code?: unknown; statusCode?: unknown };
    const code = err.code ?? err.statusCode;
    return {
      name: err.name || "Error",
      message: err.message,
      ...(typeof code === "string" || typeof code === "number"
        ? { code: String(code) }
        : {}),
      ...(err.stack ? { stack: err.stack } : {}),
    };
  }
  return { name: "UnknownError", message: String(error) };
}

function isErrorLike(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

function write(
  level: "info" | "warn" | "error",
  event: string,
  context?: LogContext,
  error?: unknown
) {
  const line = {
    level,
    event,
    ...sanitizeContext(context ?? {}),
    ...(error !== undefined ? { error: normalizeError(error) } : {}),
  };
  const output = JSON.stringify(line);
  if (level === "info") console.info(output);
  else if (level === "warn") console.warn(output);
  else console.error(output);
}

export function logInfo(event: string, context?: LogContext) {
  write("info", event, context);
}

export function logWarn(event: string, context?: LogContext) {
  write("warn", event, context);
}

export function logError(event: string, error?: unknown, context?: LogContext) {
  write("error", event, context, error);
}

// Correlation id for a request: Vercel sets `x-vercel-id` on every request,
// which joins our lines with Vercel's own request logs; fall back to a
// generated id when it is absent (local dev, other platforms).
export function getRequestId(headers: Headers): string {
  return (
    headers.get("x-vercel-id") ??
    headers.get("x-request-id") ??
    crypto.randomUUID()
  );
}
