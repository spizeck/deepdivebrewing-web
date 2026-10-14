import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo, logWarn } from "@/lib/log";
import { logAdminAudit } from "@/lib/admin-audit";
import { QboError } from "@/lib/qbo-errors";
import { applyPayoutProposal } from "@/lib/stripe-payout-executor";
import { getStripePayoutAutomationView } from "@/lib/stripe-payouts";

// The authorized apply action for Stripe payout accounting proposals.
// This is the only admin surface that can mutate QuickBooks — and only
// when the deployment's accounting mode permits it (observe refuses in
// the executor itself, not just here). The executor revalidates the
// approval fingerprint, the cutover, and live QBO state inside its own
// claim; this route only authenticates the caller and audits the result.
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
    if (typeof proposalId !== "string" || !proposalId.trim()) {
      throw new QboError("proposalId is required.", "validation", 400);
    }

    const result = await applyPayoutProposal({
      proposalId,
      actor: {
        uid: actor.token.uid,
        email: actor.token.email ?? actor.record.email,
      },
    });

    try {
      await logAdminAudit({
        action: "stripe_payout_proposal_apply",
        actingUid: actor.token.uid,
        actingEmail: actor.token.email ?? actor.record.email,
        metadata: {
          proposalId: result.proposalId,
          outcome: result.apply.outcome,
          ...(result.apply.outcome === "applied"
            ? {
                qboEntityType: result.apply.qboEntityType,
                qboEntityId: result.apply.qboEntityId,
                adopted: result.apply.adopted,
              }
            : {}),
        },
      });
    } catch {
      logWarn("qbo.audit_failed", {
        action: "stripe_payout_proposal_apply",
      });
    }
    logInfo("stripe.payout.proposal_apply", {
      proposalId: result.proposalId,
      outcome: result.apply.outcome,
      requestId,
    });
    const view = await getStripePayoutAutomationView({});
    // Non-applied outcomes are not HTTP errors — the caller needs the
    // structured verdict (refused/uncertain/failed) to render guidance.
    return NextResponse.json({ ok: true, result, view });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "The proposal could not be applied.",
      event: "stripe.payout_apply_failed",
      context: { requestId },
    });
  }
}
