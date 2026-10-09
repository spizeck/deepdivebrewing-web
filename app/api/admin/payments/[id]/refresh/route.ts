import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo } from "@/lib/log";
import {
  getPayment,
  listPaymentEvents,
  refreshAdminPayment,
} from "@/lib/payments-admin";
import {
  serializePayment,
  serializePaymentEvent,
} from "@/lib/payments-common";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Staff "refresh status" action: reconciles the record directly against
// Stripe (same transition planner the webhook uses) so a slow webhook never
// leaves a paid payment looking unpaid at the counter.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminPermission(idToken, "payments");
    const { id } = await params;
    await refreshAdminPayment(id);

    const [payment, events] = await Promise.all([
      getPayment(id),
      listPaymentEvents(id),
    ]);
    if (!payment) {
      return NextResponse.json(
        { ok: false, error: "Payment not found." },
        { status: 404 }
      );
    }
    logInfo("payment.refreshed", { paymentId: id, requestId });
    return NextResponse.json({
      ok: true,
      payment: serializePayment(payment.id, payment.data),
      events: events.map((e) => serializePaymentEvent(e.id, e.data)),
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to refresh payment status.",
      event: "payment.refresh_failed",
      context: { requestId },
    });
  }
}
