import { after, type NextRequest, NextResponse } from "next/server";
import { getRequestId, logError, logWarn } from "@/lib/log";
import { handleStripeWebhook } from "@/lib/payments-admin";
import { processStripePayoutLedger } from "@/lib/stripe-payouts";

// Stripe webhook endpoint — the authoritative reconciliation path for
// payment state (#155). Stripe delivers with a `Stripe-Signature` header
// over the *raw* body; `req.text()` preserves the exact bytes so
// constructEvent can verify it. Subscribe (Stripe Dashboard → Developers →
// Webhooks) to: checkout.session.completed, checkout.session.expired,
// checkout.session.async_payment_succeeded,
// checkout.session.async_payment_failed, and the payout lifecycle events
// (payout.created/updated/paid/failed/canceled and, where the account
// emits it, payout.reconciliation_completed).
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { ok: false, error: "Missing Stripe signature." },
      { status: 400 }
    );
  }

  const rawBody = await req.text();

  try {
    const result = await handleStripeWebhook(rawBody, signature);
    if (result.status === "retry") {
      // Canonical state had not settled — ask Stripe to redeliver rather
      // than acknowledge a transition we could not verify.
      return NextResponse.json(
        { ok: false, error: "Event deferred — retry." },
        { status: 500 }
      );
    }
    if (result.status === "unknown_payment") {
      logWarn("stripe_webhook.unknown_payment", {
        paymentId: result.paymentId,
        requestId,
      });
    }
    if (result.status === "quarantined") {
      // Canonical state contradicted the stored snapshot — acknowledged
      // durably so Stripe stops retrying, but the payment is NOT paid and
      // needs staff review.
      logWarn("stripe_webhook.quarantined", {
        paymentId: result.paymentId,
        requestId,
      });
    }
    // 200 for applied/duplicate/ignored/unknown/quarantined alike: Stripe
    // must not retry deliveries we have durably accounted for. `ignored`
    // means a valid delivery needed no state transition (e.g. a manual
    // refresh already settled the record); `duplicate` means this exact
    // Stripe event id was already processed. Neither settles twice.
    if (result.needsLedgerBuild && result.payoutId) {
      // The payout status doc + event marker are already durable, so the
      // response can return now and the heavier ledger build (balance-
      // transaction fetch, payments index, QBO payment scan, proposals)
      // runs after it — bounded, and re-runnable by the daily sweep.
      const payoutId = result.payoutId;
      after(() =>
        processStripePayoutLedger(payoutId).catch((error) =>
          logError("stripe.payout.ledger_failed", error, {
            payoutId,
            requestId,
          })
        )
      );
    }
    return NextResponse.json({ ok: true, result: result.status });
  } catch (error) {
    // Signature-construction failures are client errors — 400, no retry.
    const isSignatureError =
      (error &&
        typeof error === "object" &&
        (error as { type?: unknown }).type ===
          "StripeSignatureVerificationError") ||
      (error instanceof Error &&
        error.message.toLowerCase().includes("signature"));
    if (isSignatureError) {
      logWarn("stripe_webhook.bad_signature", { requestId });
      return NextResponse.json(
        { ok: false, error: "Invalid signature." },
        { status: 400 }
      );
    }
    // Anything else (Firestore down, Stripe enrichment outage, …) gets a 500
    // so Stripe's retry schedule replays the event later.
    logError("stripe_webhook.processing_failed", error, { requestId });
    return NextResponse.json(
      { ok: false, error: "Webhook processing failed." },
      { status: 500 }
    );
  }
}
