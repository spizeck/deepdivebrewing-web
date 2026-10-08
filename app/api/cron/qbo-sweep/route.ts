import { type NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";
import { unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo } from "@/lib/log";
import { QboConfigError } from "@/lib/qbo-errors";
import { runQboSyncSweep } from "@/lib/qbo-sweep";

// Vercel Cron entry point for the QBO sync sweeper (issue #183) —
// scheduled in vercel.json. The trust boundary is the CRON_SECRET bearer
// Vercel attaches to cron requests; there is no admin identity on a cron
// call and the route is never public. Each run is bounded (record cap +
// per-attempt timeouts), idempotent (durable claim transactions), and
// safe under concurrent invocation (a second sweeper sees live claims
// and moves on). A daily-compatible schedule is used so the deployment
// stays valid on every Vercel plan — see docs/operations/quickbooks.md.
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  if (!isAuthorizedCronRequest(req)) return unauthorizedResponse();

  try {
    const summary = await runQboSyncSweep();
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    if (error instanceof QboConfigError) {
      // QBO is not configured on this deployment — the sweep is a no-op,
      // not an alarm worth paging on.
      logInfo("qbo.sweep.skipped", { reason: "not_configured", requestId });
      return NextResponse.json({ ok: true, skipped: "not_configured" });
    }
    return apiErrorResponse(error, {
      fallback: "QuickBooks sync sweep failed.",
      event: "qbo.sweep_failed",
      context: { requestId },
    });
  }
}
