import { type NextRequest, NextResponse } from "next/server";
import { getRequestId, logError, logInfo, logWarn } from "@/lib/log";
import {
  recordQboWebhookNotifications,
  verifyQboWebhookRequest,
} from "@/lib/qbo-webhook";

// QuickBooks Online webhook receiver (issue #161). Not behind admin auth —
// the caller is Intuit — so the `intuit-signature` HMAC-SHA256 over the raw
// body (verified with the configured verifier token) is the trust boundary.
// Signature verification happens before any payload field is read.
//
// Failure contract (mirrors the Resend endpoint):
//   401 → invalid or unverifiable request (no retry desired)
//   200 → recorded, deduplicated, or safely ignored
//   500 → internal failure — Intuit may retry the delivery
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const rawPayload = await req.text();

  let notifications;
  try {
    notifications = verifyQboWebhookRequest(
      rawPayload,
      req.headers.get("intuit-signature")
    );
  } catch {
    logWarn("qbo.webhook.rejected", { requestId });
    return NextResponse.json(
      { ok: false, error: "Invalid webhook." },
      { status: 401 }
    );
  }

  try {
    const outcome = await recordQboWebhookNotifications(
      notifications,
      requestId
    );
    logInfo("qbo.webhook.processed", {
      requestId,
      received: outcome.received,
      recorded: outcome.recorded,
      duplicates: outcome.duplicates,
      ignoredRealms: outcome.ignoredRealms,
    });
    return NextResponse.json({ ok: true, ...outcome });
  } catch (error) {
    // Persistence failure → 500 so Intuit retries rather than dropping a
    // notification we never durably recorded.
    logError("qbo.webhook.processing_failed", error, { requestId });
    return NextResponse.json(
      { ok: false, error: "Webhook processing failed." },
      { status: 500 }
    );
  }
}
