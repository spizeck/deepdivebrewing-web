// Next.js instrumentation hook — initializes server-side error monitoring
// (Issue #85) and reports uncaught server errors that bypass lib/log.ts.
// Client-side capture is intentionally not registered: see
// docs/operations/observability.md for the reasoning.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initMonitoring } = await import("./lib/monitoring");
    await initMonitoring();
  }
}

// Next.js invokes this for errors that escape render/RSC/route handlers —
// including the ones that surface through app/error.tsx. Reported with only
// path/method/route metadata; headers, cookies, and bodies are never
// attached. Not-found and redirect control flow are filtered out by Next.js
// before this hook runs.
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routerKind?: string; routePath?: string; routeType?: string }
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportRequestError } = await import("./lib/monitoring");
  reportRequestError(error, request, context);
}
