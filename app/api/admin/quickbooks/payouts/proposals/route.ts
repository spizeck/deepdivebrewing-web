import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo, logWarn } from "@/lib/log";
import { logAdminAudit } from "@/lib/admin-audit";
import { QboError } from "@/lib/qbo-errors";
import { decidePayoutProposal } from "@/lib/stripe-payout-decisions";
import { getStripePayoutAutomationView } from "@/lib/stripe-payouts";

// Proposal decisions for Stripe payout accounting. POST records an
// authorized admin's approve/reject against the proposal's material
// fingerprint — bookkeeping on the proposal document only; nothing here
// posts to QuickBooks. Decisions require the "approval" (or "automatic")
// accounting mode and are refused in observe mode by the decision layer
// itself, so hiding the UI is never the authorization boundary.
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const actor = await requireAdminPermission(idToken, "accounting");

    let body: unknown;
    try {
      body = JSON.parse(await req.text());
    } catch {
      throw new QboError(
        "The request body must be valid JSON.",
        "validation",
        400
      );
    }
    const record =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : {};
    const proposalId = record.proposalId;
    const action = record.action;
    const note = record.note;
    const expectedFingerprint = record.expectedFingerprint;
    const confirmQboPaymentId = record.confirmQboPaymentId;
    if (typeof proposalId !== "string" || !proposalId.trim()) {
      throw new QboError("proposalId is required.", "validation", 400);
    }
    if (action !== "approve" && action !== "reject") {
      throw new QboError(
        'action must be "approve" or "reject".',
        "validation",
        400
      );
    }
    if (
      typeof expectedFingerprint !== "string" ||
      !expectedFingerprint.trim()
    ) {
      throw new QboError(
        "expectedFingerprint is required — decisions bind to the facts that were reviewed.",
        "validation",
        400
      );
    }
    if (note !== undefined && typeof note !== "string") {
      throw new QboError("note must be a string.", "validation", 400);
    }
    if (
      confirmQboPaymentId !== undefined &&
      typeof confirmQboPaymentId !== "string"
    ) {
      throw new QboError(
        "confirmQboPaymentId must be a string.",
        "validation",
        400
      );
    }

    const result = await decidePayoutProposal({
      proposalId,
      action,
      note,
      expectedFingerprint,
      confirmQboPaymentId,
      actor: {
        uid: actor.token.uid,
        email: actor.token.email ?? actor.record.email,
      },
    });
    const auditAction =
      action === "approve"
        ? "stripe_payout_proposal_approved"
        : "stripe_payout_proposal_rejected";
    try {
      await logAdminAudit({
        action: auditAction,
        actingUid: actor.token.uid,
        actingEmail: actor.token.email ?? actor.record.email,
        metadata: {
          proposalId: result.proposalId,
          status: result.status,
          changed: result.changed,
        },
      });
    } catch {
      logWarn("qbo.audit_failed", { action: auditAction });
    }
    logInfo("stripe.payout.proposal_decision", {
      proposalId: result.proposalId,
      action,
      changed: result.changed,
      requestId,
    });
    const view = await getStripePayoutAutomationView({});
    return NextResponse.json({ ok: true, result, view });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "The proposal decision could not be recorded.",
      event: "stripe.payout_decision_failed",
      context: { requestId },
    });
  }
}
