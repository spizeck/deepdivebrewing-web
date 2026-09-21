// TEMPORARY — Issue #85/#92 production verification only.
// Emits one controlled logError event through the normal monitoring funnel
// so the owner can verify the production pipeline end-to-end:
// admin request → logError → sanitizeError → Sentry issue → alert.
// Remove this module together with app/api/admin/monitoring/test/ and
// tests/lib/monitoring-test.test.ts once the production alert is confirmed.
import { logError, type LogContext } from "@/lib/log";

export const MONITORING_TEST_EVENT = "monitoring.test_error";

// The probe message deliberately embeds fake sensitive-looking values (never
// real customer data or secrets) so the resulting Sentry issue proves
// sanitizeError strips emails, bearer tokens, URL query strings, and opaque
// token runs before anything leaves the process.
const PROBE_MESSAGE =
  "Controlled Sentry verification probe: " +
  "email test@example.com, " +
  "Bearer ddb-probe-token-0123456789abcdef, " +
  "url https://example.com/path?email=test@example.com&token=secret, " +
  "opaque opaque-0123456789abcdef0123456789abcdef";

export function emitMonitoringTestEvent(context?: LogContext): void {
  logError(MONITORING_TEST_EVENT, new Error(PROBE_MESSAGE), {
    verification: "monitoring-test",
    ...context,
  });
}
