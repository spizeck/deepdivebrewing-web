import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { getQboReconLatest } from "@/lib/qbo-recon";
import {
  getStripePayoutAutomationView,
  processStripePayoutLedger,
} from "@/lib/stripe-payouts";
import { QboError } from "@/lib/qbo-errors";

// Stripe payout accounting-automation surface. Read-only against both
// providers: GET returns persisted payout ledgers and proposals; POST
// reprocesses one payout's ledger (admin-triggered replay of the same
// idempotent build the webhook defers to). Neither handler posts,
// adjusts, or deletes anything in QuickBooks — there is no write path
// in this build for it to reach.
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminPermission(idToken, "accounting");
    const run = await getQboReconLatest().catch(() => null);
    const view = await getStripePayoutAutomationView({
      lastReconAt: run?.ranAt,
    });
    return NextResponse.json({ ok: true, view });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Could not load the payout accounting view.",
      event: "stripe.payouts_get_failed",
      context: { requestId },
    });
  }
}

// Manual reprocess — the admin-facing recovery for a payout whose ledger
// never built (dropped deferred work, a transient Stripe outage during
// both webhook and sweep). Same bounded build as the webhook path.
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminPermission(idToken, "accounting");
    let payoutId: string | undefined;
    const raw = await req.text();
    if (raw.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      if (typeof body === "object" && body !== null) {
        const value = (body as Record<string, unknown>).payoutId;
        if (typeof value === "string" && value.trim()) {
          payoutId = value.trim();
        }
      }
    }
    if (!payoutId) {
      throw new QboError("A payoutId is required.", "validation", 400);
    }
    await processStripePayoutLedger(payoutId);
    const view = await getStripePayoutAutomationView({});
    return NextResponse.json({ ok: true, view });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "The payout could not be reprocessed.",
      event: "stripe.payout_reprocess_failed",
      context: { requestId },
    });
  }
}
