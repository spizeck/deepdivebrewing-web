import { type NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import { badRequestResponse, getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo } from "@/lib/log";
import {
  applyLeadPatch,
  getTradeLead,
  listTradeLeadActivities,
  resolveAssignee,
  tradeLeadActorOf,
} from "@/lib/trade-leads-admin";
import {
  parseLeadPatchBody,
  serializeTradeLead,
  serializeTradeLeadActivity,
  type NormalizedLeadPatch,
} from "@/lib/trade-leads-admin-common";

interface RouteParams {
  params: Promise<{ id: string }>;
}

async function leadDetail(id: string) {
  const [lead, activities] = await Promise.all([
    getTradeLead(id),
    listTradeLeadActivities(id),
  ]);
  if (!lead) return null;
  return {
    lead: serializeTradeLead(lead.id, lead.data),
    activities: activities.map((a) => serializeTradeLeadActivity(a.id, a.data)),
  };
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminActor(idToken);
    const { id } = await params;
    const detail = await leadDetail(id);
    if (!detail) {
      return NextResponse.json(
        { ok: false, error: "Trade lead not found." },
        { status: 404 }
      );
    }
    // Read-only: viewing a lead must not touch updatedAt/lastActivityAt —
    // those timestamps drive the 24-month retention window.
    return NextResponse.json({ ok: true, ...detail });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to load trade lead.",
      event: "trade_lead.get_failed",
      context: { requestId },
    });
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
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

    const parsed = parseLeadPatchBody(body);
    if (!parsed.ok) return badRequestResponse(parsed.error);

    const patch: NormalizedLeadPatch = {
      status: parsed.patch.status,
      nextFollowUpAt: parsed.patch.nextFollowUpAt,
      outcome: parsed.patch.outcome,
    };
    // The uid is untrusted input: resolve it to a verified, active admin
    // record so a forged uid/name pair can never reach the document.
    if (parsed.patch.assignedToUid !== undefined) {
      patch.assignee = parsed.patch.assignedToUid
        ? await resolveAssignee(parsed.patch.assignedToUid)
        : null;
    }

    const result = await applyLeadPatch(id, patch, tradeLeadActorOf(actor));
    if (result.changed) {
      logInfo("trade_lead.updated", {
        leadId: id,
        actions: result.activityTypes.join(","),
        requestId,
      });
    }

    const detail = await leadDetail(id);
    return NextResponse.json({ ok: true, ...detail });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to update trade lead.",
      event: "trade_lead.update_failed",
      context: { requestId },
    });
  }
}
