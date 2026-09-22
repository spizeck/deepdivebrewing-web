// TEMPORARY — covers the Issue #85 verification endpoint. Remove with
// lib/monitoring-test.ts and app/api/admin/monitoring/test/ after the
// production Sentry alert has been confirmed.
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  emitMonitoringTestEvent,
  MONITORING_TEST_EVENT,
} from "../../lib/monitoring-test";
import { __setReporterForTests, monitoringEnabled } from "../../lib/monitoring";

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

describe("monitoring verification endpoint", () => {
  it("emits a monitoring.test_error event through the logError funnel", () => {
    const payloads = captureReporter();
    try {
      emitMonitoringTestEvent({ requestId: "req-test", uid: "uid-test" });

      assert.equal(payloads.length, 1);
      assert.equal(payloads[0].event, MONITORING_TEST_EVENT);
      assert.equal(payloads[0].event, "monitoring.test_error");
      assert.equal(payloads[0].context?.verification, "monitoring-test");
      assert.equal(payloads[0].context?.requestId, "req-test");
      assert.equal(payloads[0].context?.uid, "uid-test");
    } finally {
      __setReporterForTests(null);
    }
  });

  it("strips the probe's fake sensitive values before reporting", () => {
    const payloads = captureReporter();
    try {
      emitMonitoringTestEvent({ requestId: "req-test" });

      const error = payloads[0].error as Error;
      assert.ok(error instanceof Error);
      const sent = `${error.name}\n${error.message}\n${error.stack ?? ""}`;
      assert.ok(sent.includes("Controlled Sentry verification probe"));
      for (const leaked of [
        "test@example.com",
        "ddb-probe-token",
        "token=secret",
        "email=test",
        "opaque-0123456789abcdef",
      ]) {
        assert.ok(
          !sent.includes(leaked),
          `sanitized error must not contain ${leaked}`
        );
      }
      assert.ok(error.message.length <= 300);
    } finally {
      __setReporterForTests(null);
    }
  });

  it("drops sensitive-looking context keys", () => {
    const payloads = captureReporter();
    try {
      emitMonitoringTestEvent({ token: "fake", requestId: "req-test" });
      assert.equal(payloads[0].context?.token, undefined);
      assert.equal(payloads[0].context?.requestId, "req-test");
    } finally {
      __setReporterForTests(null);
    }
  });

  it("cannot emit outside the production runtime", () => {
    // The route performs no env check of its own; reporting stays gated in
    // lib/monitoring-shared.ts on VERCEL_ENV=production + a configured DSN,
    // so preview/dev/CI calls are silent no-ops.
    for (const env of [
      {},
      {
        VERCEL_ENV: "preview",
        NEXT_RUNTIME: "nodejs",
        NEXT_PUBLIC_SENTRY_DSN: "d",
      },
      {
        VERCEL_ENV: "development",
        NEXT_RUNTIME: "nodejs",
        NEXT_PUBLIC_SENTRY_DSN: "d",
      },
      { VERCEL_ENV: "production" },
      { NEXT_PUBLIC_SENTRY_DSN: "d" },
    ]) {
      assert.equal(monitoringEnabled(env), false);
    }
    // The positive case — production + DSN, no NEXT_RUNTIME — is the
    // regression this gate previously broke.
    assert.equal(
      monitoringEnabled({
        VERCEL_ENV: "production",
        NEXT_PUBLIC_SENTRY_DSN: "d",
      }),
      true
    );
  });

  it("keeps the route admin-only and free of real secrets", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "app",
        "api",
        "admin",
        "monitoring",
        "test",
        "route.ts"
      ),
      "utf8"
    );

    // Existing centralized authorization — normal admin actor, no new
    // mechanism, no superadmin requirement.
    assert.ok(source.includes("requireAdminActor"));
    assert.ok(!source.includes("requireSuperAdminActor"));

    // Anonymous requests are rejected before any authorization or probe work.
    const bearerIdx = source.indexOf("getBearerToken(req)");
    const deniedIdx = source.indexOf('status: 401');
    const actorIdx = source.indexOf("await requireAdminActor(idToken)");
    const emitIdx = source.indexOf("emitMonitoringTestEvent(");
    assert.ok(bearerIdx > -1 && deniedIdx > bearerIdx);
    assert.ok(actorIdx > deniedIdx, "auth check must precede the probe");
    assert.ok(emitIdx > actorIdx, "probe must run only after authorization");

    // POST only — no public read surface.
    assert.ok(source.includes("export async function POST"));
    assert.ok(!source.includes("export async function GET"));

    // The synthetic probe lives in lib/monitoring-test.ts — the route must
    // not embed credentials, tokens, or probe material itself.
    assert.ok(!source.includes("ddb-probe-token"));
    assert.ok(!source.includes("test@example.com"));
    assert.ok(!source.includes("token=secret"));
  });
});
