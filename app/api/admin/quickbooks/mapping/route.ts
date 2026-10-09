import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import {
  badRequestResponse,
  getBearerToken,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { getQboMappingView, saveQboMapping } from "@/lib/qbo-mapping";

// Accounting-mapping configuration (issue #161): which connected-company
// QBO entities future Stripe/tour revenue should post against. Save
// validates every id against a live entity query.
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminPermission(idToken, "accounting");
    const mapping = await getQboMappingView();
    return NextResponse.json({ ok: true, mapping });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Could not load the QuickBooks mapping.",
      event: "qbo.mapping_get_failed",
      context: { requestId },
    });
  }
}

export async function PUT(req: NextRequest) {
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
    const actor = await requireAdminPermission(idToken, "accounting");
    const mapping = await saveQboMapping(actor, body);
    return NextResponse.json({ ok: true, mapping });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Could not save the QuickBooks mapping.",
      event: "qbo.mapping_save_failed",
      context: { requestId },
    });
  }
}
