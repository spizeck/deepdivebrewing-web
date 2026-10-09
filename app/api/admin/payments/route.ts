import { type NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import { getBearerToken, badRequestResponse, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo } from "@/lib/log";
import {
  createAdminPayment,
  listPayments,
  paymentActorOf,
} from "@/lib/payments-admin";
import {
  parsePaymentCreateBody,
  serializePayment,
} from "@/lib/payments-common";

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminActor(idToken);
    const payments = await listPayments();
    return NextResponse.json({
      ok: true,
      payments: payments.map((p) => serializePayment(p.id, p.data)),
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to load payments.",
      event: "payments.list_failed",
      context: { requestId },
    });
  }
}

export async function POST(req: NextRequest) {
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
    const actor = await requireAdminActor(idToken);
    const parsed = parsePaymentCreateBody(body);
    if (!parsed.ok) return badRequestResponse(parsed.error);

    const created = await createAdminPayment(
      parsed.input,
      paymentActorOf(actor)
    );
    // Payment id, rail, and replay flag only — never the customer PII in
    // the body.
    logInfo("payment.created", {
      paymentId: created.id,
      paymentMethod: parsed.input.paymentMethod,
      replayed: created.replayed,
      requestId,
    });

    return NextResponse.json({
      ok: true,
      payment: serializePayment(created.id, created.data),
      replayed: created.replayed,
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to create payment.",
      event: "payment.create_failed",
      context: { requestId },
    });
  }
}
