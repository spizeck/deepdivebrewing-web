"use client";

// TEMPORARY — Issue #92 browser-side verification only.
// Emits one controlled exception through the browser Sentry SDK that
// instrumentation-client.ts already initialized — same production gate,
// beforeSend scrubbing, and privacy settings as real errors. The probe
// values below are intentionally fake so the resulting Sentry event proves
// sanitization end-to-end. Remove this component and its AdminWorkspace
// usage once production browser verification is confirmed.
import { useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { Button } from "@/components/ui/button";

const PROBE_MESSAGE =
  "Controlled browser Sentry verification: email test@example.com, " +
  "Bearer ddb-browser-probe-0123456789abcdef, " +
  "url https://example.com/path?email=test@example.com&token=secret, " +
  "opaque opaque-fedcba9876543210fedcba9876543210";

export function AdminMonitoringTest() {
  const [status, setStatus] = useState<
    "idle" | "sending" | "sent" | "failed"
  >("idle");
  const [eventId, setEventId] = useState<string | null>(null);

  async function sendBrowserTest() {
    setStatus("sending");
    try {
      const id = Sentry.captureException(new Error(PROBE_MESSAGE), {
        tags: { verification: "browser-monitoring-test" },
      });
      // Bounded flush so the admin gets deterministic delivery feedback;
      // outside production the SDK is disabled and this is a harmless no-op.
      const flushed = await Sentry.flush(2000);
      setEventId(id);
      setStatus(flushed ? "sent" : "failed");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-stone bg-paper p-6">
      <h2 className="font-semibold">Monitoring diagnostics (temporary)</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Sends one controlled browser exception to Sentry with fake probe
        values to verify production capture, release, source maps, and
        sanitization. Does nothing outside production.
      </p>
      <Button
        onClick={sendBrowserTest}
        disabled={status === "sending"}
        variant="outline"
        className="mt-4"
      >
        {status === "sending" ? "Sending…" : "Send browser Sentry test"}
      </Button>
      {status === "sent" && (
        <p role="status" className="mt-3 text-sm text-ocean">
          Test event captured ({eventId}). Check Sentry for an issue tagged
          verification=browser-monitoring-test with the probe values
          redacted.
        </p>
      )}
      {status === "failed" && (
        <p role="alert" className="mt-3 text-sm text-ember">
          Test event was not confirmed delivered — expected outside
          production; in production, check the browser console and Sentry.
        </p>
      )}
    </div>
  );
}
