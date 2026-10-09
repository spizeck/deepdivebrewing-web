import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { runQboConnectionCheck } from "@/lib/qbo";

// Manual connection health check (issue #161): refreshes the token if
// needed and calls QBO CompanyInfo, then records the outcome. Returns the
// updated view — an unhealthy result is data, not a route failure.
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const actor = await requireAdminPermission(idToken, "accounting");
    const connection = await runQboConnectionCheck(actor);
    return NextResponse.json({ ok: true, connection });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "The QuickBooks connection check could not run.",
      event: "qbo.check_failed",
      context: { requestId },
    });
  }
}
