import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { getQboAdminView } from "@/lib/qbo";
import { getQboMappingView } from "@/lib/qbo-mapping";

// Serialized QuickBooks connection view for the admin surface (issue #161).
// The view is metadata-only — token material is encrypted at rest and never
// serialized to the browser.
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminPermission(idToken, "accounting");
    const [connection, mapping] = await Promise.all([
      getQboAdminView(),
      getQboMappingView().catch(() => ({ configured: false })),
    ]);
    return NextResponse.json({ ok: true, connection, mapping });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Could not load the QuickBooks connection status.",
      event: "qbo.status_failed",
      context: { requestId },
    });
  }
}
