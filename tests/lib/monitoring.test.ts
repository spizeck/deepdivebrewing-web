import { describe, it, mock } from "node:test";
import assert from "node:assert";
import {
  __setReporterForTests,
  clientMonitoringEnabled,
  fingerprintForEvent,
  monitoringEnabled,
  reportError,
  sanitizeError,
  sanitizeErrorText,
  scrubEvent,
  sentryDsn,
} from "../../lib/monitoring";
import { logError, logInfo, logWarn } from "../../lib/log";
import { apiErrorResponse } from "../../lib/api-error";

interface CapturedPayload {
  event: string;
  error?: unknown;
  context?: Record<string, unknown>;
}

function captureReporter() {
  const payloads: CapturedPayload[] = [];
  __setReporterForTests((payload) => payloads.push(payload));
  return payloads;
}

class FakeSafeError extends Error {
  readonly clientSafe = true;
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

describe("monitoringEnabled", () => {
  it("requires the production environment and a configured DSN", () => {
    assert.equal(
      monitoringEnabled({
        VERCEL_ENV: "production",
        NEXT_RUNTIME: "nodejs",
        NEXT_PUBLIC_SENTRY_DSN: "https://x@o0.ingest.sentry.io/1",
      }),
      true
    );
    // Legacy SENTRY_DSN still enables during the cutover.
    assert.equal(
      monitoringEnabled({
        VERCEL_ENV: "production",
        NEXT_RUNTIME: "nodejs",
        SENTRY_DSN: "https://x@o0.ingest.sentry.io/1",
      }),
      true
    );
    // Production build/prerender has VERCEL_ENV=production but no runtime.
    assert.equal(
      monitoringEnabled({
        VERCEL_ENV: "production",
        NEXT_PUBLIC_SENTRY_DSN: "d",
      }),
      false
    );
    assert.equal(
      monitoringEnabled({
        VERCEL_ENV: "preview",
        NEXT_RUNTIME: "nodejs",
        NEXT_PUBLIC_SENTRY_DSN: "d",
      }),
      false
    );
    assert.equal(
      monitoringEnabled({
        VERCEL_ENV: "development",
        NEXT_RUNTIME: "nodejs",
        NEXT_PUBLIC_SENTRY_DSN: "d",
      }),
      false
    );
    assert.equal(monitoringEnabled({}), false);
  });
});

describe("sentryDsn", () => {
  it("prefers NEXT_PUBLIC_SENTRY_DSN and falls back to legacy SENTRY_DSN", () => {
    assert.equal(
      sentryDsn({ NEXT_PUBLIC_SENTRY_DSN: "new", SENTRY_DSN: "old" }),
      "new"
    );
    assert.equal(sentryDsn({ SENTRY_DSN: "old" }), "old");
    assert.equal(sentryDsn({}), undefined);
  });
});

describe("clientMonitoringEnabled", () => {
  it("reports only when the public DSN exists on a production Vercel build", () => {
    assert.equal(
      clientMonitoringEnabled({
        NEXT_PUBLIC_SENTRY_DSN: "d",
        NEXT_PUBLIC_VERCEL_ENV: "production",
      }),
      true
    );
    // Preview builds get NEXT_PUBLIC_VERCEL_ENV=preview — off even if the
    // DSN were ever scoped too broadly.
    assert.equal(
      clientMonitoringEnabled({
        NEXT_PUBLIC_SENTRY_DSN: "d",
        NEXT_PUBLIC_VERCEL_ENV: "preview",
      }),
      false
    );
    // Local dev / CI / local next start: no Vercel env vars → inert.
    assert.equal(
      clientMonitoringEnabled({ NEXT_PUBLIC_SENTRY_DSN: "d" }),
      false
    );
    assert.equal(
      clientMonitoringEnabled({ NEXT_PUBLIC_VERCEL_ENV: "production" }),
      false
    );
    assert.equal(clientMonitoringEnabled({}), false);
    // The legacy server-only DSN never enables the browser SDK.
    assert.equal(
      clientMonitoringEnabled({
        SENTRY_DSN: "d",
        NEXT_PUBLIC_VERCEL_ENV: "production",
      }),
      false
    );
  });
});

describe("scrubEvent", () => {
  it("strips headers, cookies, body, query, and user context", () => {
    const event = {
      request: {
        url: "https://deepdivebrewing.com/api/trade-inquiry?email=a@b.c",
        method: "POST",
        headers: { authorization: "Bearer secret", cookie: "session=1" },
        cookies: { session: "1" },
        data: { email: "a@b.c", message: "inquiry body" },
        query_string: "email=a@b.c",
      },
      user: { id: "u1", email: "a@b.c", ip_address: "1.2.3.4" },
      breadcrumbs: [{ message: "clicked" }],
      tags: { event: "trade_inquiry.unexpected" },
      extra: { requestId: "r1", api_key: "leak", leadId: "l9" },
    };

    const scrubbed = scrubEvent(event) as {
      request: Record<string, unknown>;
      extra: Record<string, unknown>;
      tags: Record<string, string>;
    };

    assert.equal(
      scrubbed.request.url,
      "https://deepdivebrewing.com/api/trade-inquiry"
    );
    assert.equal(scrubbed.request.method, "POST");
    assert.equal(scrubbed.request.headers, undefined);
    assert.equal(scrubbed.request.cookies, undefined);
    assert.equal(scrubbed.request.data, undefined);
    assert.equal(scrubbed.request.query_string, undefined);
    assert.equal((scrubbed as Record<string, unknown>).user, undefined);
    assert.equal(
      (scrubbed as Record<string, unknown>).breadcrumbs,
      undefined
    );
    assert.equal(scrubbed.extra.requestId, "r1");
    assert.equal(scrubbed.extra.leadId, "l9");
    assert.equal(scrubbed.extra.api_key, undefined);
    assert.equal(scrubbed.tags.event, "trade_inquiry.unexpected");
  });

  it("strips query strings from browser-style events and nextjs request_path", () => {
    const event = {
      // Shape produced by the browser SDK for a page error.
      request: {
        url: "https://deepdivebrewing.com/admin?invite_token=abc123#frag",
        headers: { Referer: "https://deepdivebrewing.com/?token=x" },
      },
      contexts: {
        nextjs: { request_path: "/api/x?secret=1", route_type: "route" },
        browser: { name: "Chrome" },
      },
      user: { ip_address: "203.0.113.7" },
    };

    const scrubbed = scrubEvent(event) as {
      request: Record<string, unknown>;
      contexts: { nextjs: Record<string, unknown> };
    };
    assert.equal(
      scrubbed.request.url,
      "https://deepdivebrewing.com/admin"
    );
    assert.equal(scrubbed.request.headers, undefined);
    assert.equal(scrubbed.contexts.nextjs.request_path, "/api/x");
    assert.equal(scrubbed.contexts.nextjs.route_type, "route");
    assert.equal((scrubbed as Record<string, unknown>).user, undefined);
  });

  it("removes stack-frame local variables (may embed customer data)", () => {
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value: "send failed for customer@example.com",
            stacktrace: {
              frames: [
                {
                  filename: "app/api/trade-inquiry/route.ts",
                  function: "POST",
                  vars: { email: "customer@example.com", token: "abc" },
                },
              ],
            },
          },
        ],
      },
    };

    const scrubbed = scrubEvent(event) as {
      exception: {
        values: Array<{
          value: string;
          stacktrace: { frames: Array<Record<string, unknown>> };
        }>;
      };
    };
    const frame = scrubbed.exception.values[0].stacktrace.frames[0];
    assert.equal(frame.vars, undefined);
    assert.equal(
      scrubbed.exception.values[0].value.includes("customer@example.com"),
      false
    );
  });
});

describe("reportError funnel", () => {
  it("does not throw when monitoring is disabled", () => {
    // No DSN/VERCEL_ENV in the test environment — must be a silent no-op.
    assert.doesNotThrow(() =>
      reportError("test.event", new Error("x"), { requestId: "r" })
    );
  });

  it("reports logError events with sanitized context", () => {
    const payloads = captureReporter();
    const consoleSpy = mock.method(console, "error", () => {});
    try {
      logError("trade_inquiry.persistence_failed", new Error("firestore down"), {
        requestId: "r1",
        authorization: "Bearer token",
        venueType: "bar",
      });
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0].event, "trade_inquiry.persistence_failed");
      assert.equal(payloads[0].error instanceof Error, true);
      // The Sentry-bound error is the sanitized representation.
      assert.equal(
        (payloads[0].error as Error).message,
        "firestore down"
      );
      assert.equal(payloads[0].context?.requestId, "r1");
      assert.equal(payloads[0].context?.venueType, "bar");
      assert.equal(payloads[0].context?.authorization, undefined);
    } finally {
      consoleSpy.mock.restore();
      __setReporterForTests(null);
    }
  });

  it("sends only sanitized exception content for hostile provider errors", () => {
    const payloads = captureReporter();
    const consoleSpy = mock.method(console, "error", () => {});
    try {
      const providerFailure = new Error(
        "delivery failed: smtp 550 for customer@example.com " +
          "at https://api.resend.com/emails?api_key=re_secret_123 " +
          "Authorization: Bearer bearer-token-value-456"
      );
      logError("trade_inquiry.notification_failed", providerFailure, {
        leadId: "lead-1",
        requestId: "req-1",
      });

      const bound = payloads[0].error as Error;
      const serialized = `${bound.name}: ${bound.message}\n${bound.stack}`;
      for (const sensitive of [
        "customer@example.com",
        "re_secret_123",
        "api_key",
        "bearer-token-value-456",
      ]) {
        assert.equal(
          serialized.includes(sensitive),
          false,
          `Sentry-bound error still contains: ${sensitive}`
        );
      }
      // Diagnostic identity survives.
      assert.ok(bound.message.includes("delivery failed"));
      assert.ok(bound.message.includes("https://api.resend.com/emails"));
      // Correlation context (leadId/requestId) is retained — ids are chosen
      // operational values, not customer content.
      assert.equal(payloads[0].context?.leadId, "lead-1");
      assert.equal(payloads[0].context?.requestId, "req-1");
    } finally {
      consoleSpy.mock.restore();
      __setReporterForTests(null);
    }
  });

  it("never reports info or warn events", () => {
    const payloads = captureReporter();
    const infoSpy = mock.method(console, "info", () => {});
    const warnSpy = mock.method(console, "warn", () => {});
    try {
      logInfo("trade_inquiry.persisted", { leadId: "l1" });
      logWarn("admin_auth.denied", { uid: "u1", reason: "no record" });
      assert.equal(payloads.length, 0);
    } finally {
      infoSpy.mock.restore();
      warnSpy.mock.restore();
      __setReporterForTests(null);
    }
  });

  it("reports unexpected API errors but not expected client-safe denials", async () => {
    const payloads = captureReporter();
    const consoleSpy = mock.method(console, "error", () => {});
    try {
      const internal = apiErrorResponse(new Error("db exploded"), {
        fallback: "Failed.",
        event: "admin_users.update_failed",
        context: { requestId: "r2" },
      });
      assert.equal(internal.status, 500);
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0].event, "admin_users.update_failed");

      const denied = apiErrorResponse(new FakeSafeError("Requires admin.", 403), {
        fallback: "Failed.",
        event: "admin_users.update_failed",
      });
      assert.equal(denied.status, 403);
      // Expected denials produce no monitoring noise.
      assert.equal(payloads.length, 1);
    } finally {
      consoleSpy.mock.restore();
      __setReporterForTests(null);
    }
  });

  it("survives a throwing reporter without breaking the caller", async () => {
    __setReporterForTests(() => {
      throw new Error("provider down");
    });
    const consoleSpy = mock.method(console, "error", () => {});
    try {
      assert.doesNotThrow(() =>
        logError("trade_inquiry.unexpected", new Error("x"))
      );
      const res = apiErrorResponse(new Error("x"), {
        fallback: "Failed.",
        event: "test.failed",
      });
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { ok: false, error: "Failed." });
    } finally {
      consoleSpy.mock.restore();
      __setReporterForTests(null);
    }
  });
});

describe("sanitizeErrorText", () => {
  it("removes emails, bearer tokens, URL queries, keys, and long tokens", () => {
    const dirty =
      'query for customer@example.com failed; auth Bearer super-secret-token; ' +
      'fetch https://example.com/path?email=customer@example.com&token=secret ' +
      'api_key=AIzaSyD4iE2xVSpkL1XLOq15n8vY qwer; ' +
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlfUPjzTHs ' +
      'token: ak_live_51H8xYzAbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd';

    const clean = sanitizeErrorText(dirty);
    for (const sensitive of [
      "customer@example.com",
      "super-secret-token",
      "token=secret",
      "email=",
      "AIzaSyD4iE2xVSpkL1XLOq15n8vY",
      "eyJhbGciOiJIUzI1NiJ9",
      "ak_live_51H8xYzAbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd",
    ]) {
      assert.equal(
        clean.includes(sensitive),
        false,
        `sanitized text still contains: ${sensitive}`
      );
    }
    // Diagnostic skeleton survives: URL keeps origin+path, error context kept.
    assert.ok(clean.includes("https://example.com/path"));
    assert.ok(clean.includes("[redacted]"));
    assert.ok(clean.includes("[email]"));
  });

  it("bounds excessively long messages", () => {
    const long = `boom: ${"x".repeat(5000)}`;
    const clean = sanitizeErrorText(long);
    assert.ok(clean.length <= 301);
    assert.ok(clean.startsWith("boom: "));
  });
});

describe("sanitizeError", () => {
  it("produces a safe Error preserving name, code, and stack shape", () => {
    const raw = new Error(
      "Firestore write failed for customer@example.com (Bearer tok-abc123)"
    );
    raw.name = "FirebaseError";
    (raw as Error & { code?: string }).code = "permission-denied";

    const safe = sanitizeError(raw);

    assert.equal(safe.name, "FirebaseError");
    assert.equal((safe as Error & { code?: string }).code, "permission-denied");
    assert.equal(safe.message.includes("customer@example.com"), false);
    assert.equal(safe.message.includes("tok-abc123"), false);
    assert.ok(safe.message.includes("Firestore write failed"));
    // Stack preserved with a sanitized first line and intact frames —
    // Sentry can still group and locate the failure.
    assert.ok(safe.stack!.startsWith("FirebaseError:"));
    assert.equal(safe.stack!.includes("customer@example.com"), false);
    assert.ok(safe.stack!.split("\n").some((l) => l.trim().startsWith("at ")));
  });

  it("sanitizes provider-style error objects and non-Error values", () => {
    const providerError = {
      name: "ResendError",
      message: "send rejected for customer@example.com",
      statusCode: 422,
    };
    const safe = sanitizeError(providerError);
    assert.equal(safe.name, "ResendError");
    assert.equal(safe.message.includes("customer@example.com"), false);
    assert.equal((safe as Error & { code?: string }).code, "422");

    const primitive = sanitizeError("plain string failure token=abc123secret");
    assert.equal(primitive.message.includes("token=abc123secret"), false);
  });
});

describe("fingerprintForEvent", () => {
  it("keeps deterministic event-name grouping for curated logError events", () => {
    for (const event of [
      "trade_inquiry.persistence_failed",
      "trade_inquiry.notification_failed",
      "admin_rebuild.hook_failed",
    ]) {
      assert.deepEqual(fingerprintForEvent(event), [
        "deepdivebrewing",
        event,
      ]);
    }
  });
});

// Uncaught server errors no longer flow through the curated funnel:
// instrumentation.ts onRequestError delegates to Sentry.captureRequestError
// (tagged `event: next.request_error`), so SDK-native grouping keeps
// distinct exceptions distinct. See smoke-tests and sentry-config.test.ts.
