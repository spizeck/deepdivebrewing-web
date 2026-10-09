import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { getPayment, listPaymentEvents } from "@/lib/payments-admin";
import {
  serializePayment,
  serializePaymentEvent,
} from "@/lib/payments-common";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminPermission(idToken, "payments");
    const { id } = await params;
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
    return NextResponse.json({
      ok: true,
      payment: serializePayment(payment.id, payment.data),
      events: events.map((e) => serializePaymentEvent(e.id, e.data)),
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to load payment.",
      event: "payment.get_failed",
      context: { requestId },
    });
  }
}
