import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import {
  badRequestResponse,
  getBearerToken,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { disconnectQbo, getQboAdminView } from "@/lib/qbo";

// Deliberate disconnect (issue #161): requires an explicit confirmation
// body, revokes the grant at Intuit, and destroys stored credentials while
// keeping the audit/history record.
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
  const confirm =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).confirm
      : undefined;
  if (confirm !== true) {
    return badRequestResponse("Disconnect requires explicit confirmation.");
  }

  try {
    const actor = await requireAdminPermission(idToken, "accounting");
    await disconnectQbo(actor);
    const connection = await getQboAdminView();
    return NextResponse.json({ ok: true, connection });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Could not disconnect QuickBooks.",
      event: "qbo.disconnect_failed",
      context: { requestId },
    });
  }
}
