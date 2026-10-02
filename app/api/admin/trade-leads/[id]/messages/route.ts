import { type NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import {
  badRequestResponse,
  getBearerToken,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo } from "@/lib/log";
import {
  getTradeLeadDetail,
  tradeLeadActorOf,
} from "@/lib/trade-leads-admin";
import {
  parseOutboundMessageBody,
  sendLeadEmail,
} from "@/lib/trade-leads-email";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Sends an admin-composed email to the lead's contact address (Issue #152).
// The recipient is always the lead's stored email — the request cannot aim
// the message at an arbitrary address, so the endpoint is not a mail relay.
// The send is recorded on the lead (communication doc + timeline entry)
// whether or not the provider accepts it, so the history never claims a
// message that did not happen.
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
    const actor = await requireAdminActor(idToken);
    const { id } = await params;

    const parsed = parseOutboundMessageBody(body);
    if (!parsed.ok) return badRequestResponse(parsed.error);

    const result = await sendLeadEmail(
      id,
      parsed.message,
      tradeLeadActorOf(actor)
    );
    logInfo("trade_lead.email_sent", {
      leadId: id,
      communicationId: result.communicationId,
      requestId,
    });

    const detail = await getTradeLeadDetail(id);
    return NextResponse.json({ ok: true, ...detail });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to send the email.",
      event: "trade_lead.email_send_failed",
      context: { requestId },
    });
  }
}
