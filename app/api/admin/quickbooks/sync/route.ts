import { type NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo, logWarn } from "@/lib/log";
import { logAdminAudit } from "@/lib/admin-audit";
import { QboConfigError } from "@/lib/qbo-errors";
import { getQboSyncAdminView } from "@/lib/qbo-sync-admin";
import { runQboSyncSweep } from "@/lib/qbo-sweep";

// QuickBooks sync operations surface (issue #183).
//   GET  — compact status view: counts by status, paused state, and the
//          recent failed/needs_attention records for the admin panel.
//   POST — admin-triggered sweep: the same bounded, idempotent run the
//          cron route performs, for on-demand catch-up after a reconnect
//          or a fixed mapping. Audited like other admin actions.
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminActor(idToken);
    const sync = await getQboSyncAdminView();
    return NextResponse.json({ ok: true, sync });
  } catch (error) {
    if (error instanceof QboConfigError) {
      // QBO not configured on this deployment — an empty view, not a
      // failure the admin UI needs to surface.
      return NextResponse.json({ ok: true, sync: null });
    }
    return apiErrorResponse(error, {
      fallback: "Could not load the QuickBooks sync status.",
      event: "qbo.sync_view_failed",
      context: { requestId },
    });
  }
}

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const actor = await requireAdminActor(idToken);
    const summary = await runQboSyncSweep();
    try {
      await logAdminAudit({
        action: "qbo_sweep_triggered",
        actingUid: actor.token.uid,
        actingEmail: actor.token.email ?? actor.record.email,
        metadata: {
          environment: summary.environment,
          enqueued: summary.enqueued,
          processed: summary.processed,
          paused: summary.paused,
        },
      });
    } catch {
      logWarn("qbo.audit_failed", { action: "qbo_sweep_triggered" });
    }
    logInfo("qbo.sweep.admin_triggered", {
      environment: summary.environment,
      requestId,
    });
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "The QuickBooks sync sweep could not run.",
      event: "qbo.sweep_failed",
      context: { requestId },
    });
  }
}
