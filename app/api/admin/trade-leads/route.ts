import { type NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import { getBearerToken, badRequestResponse, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo } from "@/lib/log";
import {
  createManualTradeLead,
  getTradeLead,
  listAssignableAdmins,
  listTradeLeads,
  tradeLeadActorOf,
} from "@/lib/trade-leads-admin";
import {
  parseManualLeadBody,
  serializeTradeLead,
} from "@/lib/trade-leads-admin-common";

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminActor(idToken);
    const [leads, admins] = await Promise.all([
      listTradeLeads(),
      listAssignableAdmins(),
    ]);
    return NextResponse.json({
      ok: true,
      leads: leads.map((lead) => serializeTradeLead(lead.id, lead.data)),
      admins,
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to load trade leads.",
      event: "trade_leads.list_failed",
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
    const parsed = parseManualLeadBody(body);
    if (!parsed.ok) return badRequestResponse(parsed.error);

    // Lead id and action name only — never the submitted PII (#150).
    const leadId = await createManualTradeLead(
      parsed.input,
      tradeLeadActorOf(actor)
    );
    logInfo("trade_lead.created", {
      leadId,
      source: parsed.input.source,
      requestId,
    });

    const created = await getTradeLead(leadId);
    return NextResponse.json({
      ok: true,
      lead: created ? serializeTradeLead(created.id, created.data) : null,
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to create trade lead.",
      event: "trade_lead.create_failed",
      context: { requestId },
    });
  }
}
