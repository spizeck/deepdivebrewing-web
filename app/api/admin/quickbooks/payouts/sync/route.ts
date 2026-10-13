import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo, logWarn } from "@/lib/log";
import { logAdminAudit } from "@/lib/admin-audit";
import { QboError } from "@/lib/qbo-errors";
import {
  getStripePayoutAutomationView,
  syncStripePayouts,
} from "@/lib/stripe-payouts";

// Admin-triggered Stripe payout synchronization — the on-demand
// counterpart of the daily cron sweep, for recovering payouts whose
// webhook events were never delivered (e.g. historical payouts created
// before the destination subscribed to payout lifecycle events).
//   POST {}                  — scan the 35-day lookback and process every
//                              payout needing work (bounded: a deeper
//                              backlog reports `remaining`; run again to
//                              continue — every step is idempotent).
//   POST {"payoutId":"po_…"} — sync one payout by id for targeted
//                              recovery. Same canonical fetch, same
//                              ingestion, same cutover rules.
// The response carries the sync summary plus a refreshed automation view
// so the dashboard reflects the run immediately. Observe-mode only: the
// pipeline persists ledgers and proposals — no QBO write path exists.
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const actor = await requireAdminPermission(idToken, "accounting");

    let payoutId: string | undefined;
    const raw = await req.text();
    if (raw.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new QboError(
          "The request body must be valid JSON.",
          "validation",
          400
        );
      }
      if (typeof body === "object" && body !== null) {
        const value = (body as Record<string, unknown>).payoutId;
        if (value !== undefined) {
          if (typeof value !== "string" || !value.trim()) {
            throw new QboError(
              "payoutId must be a non-empty string.",
              "validation",
              400
            );
          }
          payoutId = value.trim();
        }
      }
    }

    const summary = await syncStripePayouts({ payoutId });
    try {
      await logAdminAudit({
        action: "stripe_payout_sync_triggered",
        actingUid: actor.token.uid,
        actingEmail: actor.token.email ?? actor.record.email,
        metadata: {
          environment: summary.environment,
          scope: summary.scope,
          discovered: summary.discovered,
          processed: summary.processed,
          statusRecorded: summary.statusRecorded,
          alreadyCurrent: summary.alreadyCurrent,
          failed: summary.failed,
          remaining: summary.remaining,
        },
      });
    } catch {
      logWarn("qbo.audit_failed", {
        action: "stripe_payout_sync_triggered",
      });
    }
    logInfo("stripe.payout.sync_triggered", {
      environment: summary.environment,
      scope: summary.scope,
      requestId,
    });
    const view = await getStripePayoutAutomationView({});
    return NextResponse.json({ ok: true, summary, view });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "The payout sync could not run.",
      event: "stripe.payout_sync_failed",
      context: { requestId },
    });
  }
}
