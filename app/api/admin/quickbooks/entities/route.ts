import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import {
  badRequestResponse,
  getBearerToken,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { queryQboEntities } from "@/lib/qbo-api";
import { getQboEnvironment } from "@/lib/qbo-config";
import { getQuickBooksAccessToken } from "@/lib/qbo-tokens";
import { isQboDiscoveryEntityType } from "@/lib/qbo-common";

// Read-only entity discovery for the accounting-mapping surface
// (issue #161). Returns canonical safe summaries — ids, names, types —
// never raw QBO records.
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  const type = req.nextUrl.searchParams.get("type");
  if (!isQboDiscoveryEntityType(type)) {
    return badRequestResponse("Unknown entity type.");
  }

  try {
    await requireAdminPermission(idToken, "accounting");
    const { accessToken, realmId } = await getQuickBooksAccessToken();
    const entities = await queryQboEntities({
      environment: getQboEnvironment(),
      realmId,
      accessToken,
      type,
    });
    return NextResponse.json({ ok: true, entities });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Could not load QuickBooks entities.",
      event: "qbo.entities_failed",
      context: { requestId },
    });
  }
}
