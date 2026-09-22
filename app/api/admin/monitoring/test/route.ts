// TEMPORARY — Issue #85/#92 production verification only.
// Admin-only endpoint that emits one controlled `monitoring.test_error`
// logError event to verify the production Sentry pipeline end-to-end. It is
// a no-op outside production (monitoring stays gated on VERCEL_ENV +
// a configured DSN) and must be removed once the production
// alert has been confirmed. See docs/operations/observability.md.
import { NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import { getBearerToken } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { emitMonitoringTestEvent } from "@/lib/monitoring-test";

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  try {
    const idToken = getBearerToken(req);
    if (!idToken) {
      return NextResponse.json(
        { ok: false, error: "Missing auth token." },
        { status: 401 }
      );
    }

    // Verified token + admin claim + existing active adminUsers record with a
    // matching role (see requireAdminActor). Normal admin access suffices —
    // this is an operational probe, not a configuration change.
    const actor = await requireAdminActor(idToken);

    emitMonitoringTestEvent({ requestId, uid: actor.token.uid });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Monitoring verification request failed.",
      event: "monitoring.test_unexpected",
      context: { requestId },
    });
  }
}
