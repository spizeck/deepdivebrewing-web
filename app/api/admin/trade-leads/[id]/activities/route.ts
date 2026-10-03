import { type NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import { badRequestResponse, getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo } from "@/lib/log";
import {
  addTradeLeadNote,
  getTradeLeadDetail,
  tradeLeadActorOf,
} from "@/lib/trade-leads-admin";
import { validateNoteBody } from "@/lib/trade-leads-admin-common";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Append-only internal note. The note body is lead PII-adjacent content:
// logged as lead id + action only.
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

    const parsed = validateNoteBody(
      (body as Record<string, unknown>)?.note
    );
    if (!parsed.ok) return badRequestResponse(parsed.error);

    await addTradeLeadNote(id, parsed.note, tradeLeadActorOf(actor));
    logInfo("trade_lead.note_added", { leadId: id, requestId });

    const detail = await getTradeLeadDetail(id);
    return NextResponse.json({ ok: true, ...detail });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to add note.",
      event: "trade_lead.note_failed",
      context: { requestId },
    });
  }
}
