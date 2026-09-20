import { describe, it, mock } from "node:test";
import assert from "node:assert";
import {
  __setReporterForTests,
  monitoringEnabled,
  reportError,
  reportRequestError,
  scrubEvent,
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
        SENTRY_DSN: "https://x@o0.ingest.sentry.io/1",
      }),
      true
    );
    // Production build/prerender has VERCEL_ENV=production but no runtime.
    assert.equal(
      monitoringEnabled({ VERCEL_ENV: "production", SENTRY_DSN: "d" }),
      false
    );
    assert.equal(
      monitoringEnabled({
        VERCEL_ENV: "preview",
        NEXT_RUNTIME: "nodejs",
        SENTRY_DSN: "d",
      }),
      false
    );
    assert.equal(
      monitoringEnabled({
        VERCEL_ENV: "development",
        NEXT_RUNTIME: "nodejs",
        SENTRY_DSN: "d",
      }),
      false
    );
    assert.equal(monitoringEnabled({}), false);
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
      assert.equal(payloads[0].context?.requestId, "r1");
      assert.equal(payloads[0].context?.venueType, "bar");
      assert.equal(payloads[0].context?.authorization, undefined);
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

describe("reportRequestError", () => {
  it("reports uncaught server errors with path/method only", () => {
    const payloads = captureReporter();
    try {
      reportRequestError(
        new Error("render blew up"),
        { path: "/beers/rock", method: "GET" },
        { routerKind: "App Router", routePath: "/beers/[slug]", routeType: "render" }
      );
      assert.equal(payloads.length, 1);
      assert.equal(payloads[0].event, "next.request_error");
      assert.equal(payloads[0].context?.path, "/beers/rock");
      assert.equal(payloads[0].context?.method, "GET");
      assert.equal(payloads[0].context?.routePath, "/beers/[slug]");
    } finally {
      __setReporterForTests(null);
    }
  });
});
