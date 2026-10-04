import { type NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { requireAdminActor } from "@/lib/admin-auth";
import {
  badRequestResponse,
  getBearerToken,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { getPayment } from "@/lib/payments-admin";
import { normalizePaymentStatus, isPaymentPayable } from "@/lib/payments-common";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// QR code for the live hosted payment page — the counter flow: the customer
// scans and pays on their own phone. Generated on demand (derived from the
// stored session URL) rather than persisted.
export async function GET(req: NextRequest, { params }: RouteParams) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminActor(idToken);
    const { id } = await params;
    const payment = await getPayment(id);
    if (!payment) {
      return NextResponse.json(
        { ok: false, error: "Payment not found." },
        { status: 404 }
      );
    }
    const url =
      typeof payment.data.stripeSessionUrl === "string"
        ? payment.data.stripeSessionUrl
        : null;
    if (!url || !isPaymentPayable(normalizePaymentStatus(payment.data.status))) {
      return badRequestResponse("No live payment link for this payment.");
    }

    const dataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
    });
    return NextResponse.json({ ok: true, dataUrl });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to generate QR code.",
      event: "payment.qr_failed",
      context: { requestId },
    });
  }
}
