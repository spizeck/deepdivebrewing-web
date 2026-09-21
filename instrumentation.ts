// Next.js instrumentation hook — initializes error monitoring (Issues #85,
// #92) and reports uncaught server errors that bypass lib/log.ts.
// - register() loads the server Sentry config only under the nodejs runtime
//   (this app has no edge runtime; the browser SDK initializes itself via
//   instrumentation-client.ts).
// - onRequestError delegates to Sentry.captureRequestError — the supported
//   capture path for render/RSC/route-handler errors — tagged with the same
//   `event: next.request_error` marker the previous funnel used, so the
//   events remain filterable. beforeSend (lib/monitoring-shared.ts
//   scrubEvent) strips headers, cookies, bodies, and query strings; Next.js
//   filters not-found/redirect control flow before this hook runs.

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}

export async function onRequestError(
  error: unknown,
  request: {
    path: string;
    method: string;
    headers: Record<string, string | string[] | undefined>;
  },
  context: { routerKind: string; routePath: string; routeType: string }
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const Sentry = await import("@sentry/nextjs");
  // captureRequestError opens its own scope clone, which inherits tags set
  // on the enclosing scope — this keeps the `event` tag without touching
  // global scope state.
  Sentry.withScope((scope) => {
    scope.setTag("event", "next.request_error");
    Sentry.captureRequestError(error, request, context);
  });
}
