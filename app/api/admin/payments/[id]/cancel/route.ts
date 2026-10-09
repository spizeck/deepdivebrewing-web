import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo } from "@/lib/log";
import {
  cancelAdminPayment,
  getPayment,
  listPaymentEvents,
  paymentActorOf,
} from "@/lib/payments-admin";
import {
  serializePayment,
  serializePaymentEvent,
} from "@/lib/payments-common";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Staff cancel: expires the hosted Stripe page and marks the payment
// canceled. Only unpaid payments may be canceled — enforced server-side
// inside the mutation.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const actor = await requireAdminPermission(idToken, "payments");
    const { id } = await params;
    await cancelAdminPayment(id, paymentActorOf(actor));
    logInfo("payment.canceled", { paymentId: id, requestId });

    const [payment, events] = await Promise.all([
      getPayment(id),
      listPaymentEvents(id),
    ]);
    return NextResponse.json({
      ok: true,
      payment: payment ? serializePayment(payment.id, payment.data) : null,
      events: events.map((e) => serializePaymentEvent(e.id, e.data)),
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to cancel payment.",
      event: "payment.cancel_failed",
      context: { requestId },
    });
  }
}
