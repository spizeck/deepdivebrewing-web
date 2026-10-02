import { type NextRequest, NextResponse } from "next/server";
import { getRequestId, logError, logInfo } from "@/lib/log";
import {
  applyDeliveryEvent,
  handleInboundEmail,
  verifyResendWebhook,
} from "@/lib/trade-leads-email";

// Resend webhook endpoint (Issue #152): inbound customer replies
// (email.received) and outbound delivery-state callbacks (email.delivered,
// email.bounced, …). Not behind admin auth — the caller is Resend — so the
// svix signature on the raw body is the trust boundary, verified before any
// payload is touched.
//
// Failure contract:
//   401/400 → invalid or unverifiable request (no retry desired)
//   200     → handled, ignored, or already recorded (idempotent)
//   500     → transient/internal failure — Resend retries the delivery
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const rawPayload = await req.text();

  let event;
  try {
    event = verifyResendWebhook(rawPayload, {
      // Resend uses the Standard Webhooks header set.
      id: req.headers.get("svix-id") ?? req.headers.get("webhook-id"),
      timestamp:
        req.headers.get("svix-timestamp") ??
        req.headers.get("webhook-timestamp"),
      signature:
        req.headers.get("svix-signature") ??
        req.headers.get("webhook-signature"),
    });
  } catch (error) {
    logError("trade_email.webhook_rejected", error, { requestId });
    return NextResponse.json(
      { ok: false, error: "Invalid webhook." },
      { status: 401 }
    );
  }

  try {
    if (event.type === "email.received") {
      const outcome = await handleInboundEmail(event.data);
      logInfo("trade_email.inbound_processed", { requestId, outcome });
      return NextResponse.json({ ok: true, outcome });
    }

    const outcome = await applyDeliveryEvent(event.type, event.data);
    if (outcome !== "ignored") {
      logInfo("trade_email.delivery_processed", { requestId, outcome });
    }
    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    // Processing failure → 500 so the provider retries rather than silently
    // dropping a customer reply.
    logError("trade_email.webhook_processing_failed", error, { requestId });
    return NextResponse.json(
      { ok: false, error: "Webhook processing failed." },
      { status: 500 }
    );
  }
}
