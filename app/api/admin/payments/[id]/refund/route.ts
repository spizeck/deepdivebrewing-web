import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import { getBearerToken, badRequestResponse, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo } from "@/lib/log";
import {
  getPayment,
  listPaymentEvents,
  paymentActorOf,
  refundAdminPayment,
} from "@/lib/payments-admin";
import {
  parseRefundBody,
  serializePayment,
  serializePaymentEvent,
} from "@/lib/payments-common";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Staff full refund. The request carries intent only — a reason and the
// typed confirmation phrase; the amount is always derived from the stored
// record server-side, and eligibility (paid, inside the 1-hour window,
// not already refunded) is enforced inside the mutation.
export async function POST(req: NextRequest, { params }: RouteParams) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequestResponse("Invalid JSON body.");
  }

  try {
    const actor = await requireAdminPermission(idToken, "payments");
    const parsed = parseRefundBody(body);
    if (!parsed.ok) return badRequestResponse(parsed.error);

    const { id } = await params;
    await refundAdminPayment(id, parsed.input, paymentActorOf(actor));
    logInfo("payment.refunded", { paymentId: id, requestId });

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
      fallback: "Failed to refund payment.",
      event: "payment.refund_failed",
      context: { requestId },
    });
  }
}
