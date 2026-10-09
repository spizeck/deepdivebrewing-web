import { type NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { getKnowledgeVersion } from "@/lib/knowledge-admin";

interface RouteParams {
  params: Promise<{ id: string; versionId: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminActor(idToken);
    const { id, versionId } = await params;
    const version = await getKnowledgeVersion(
      id,
      versionId
    );
    return NextResponse.json({ ok: true, version });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to load knowledge version.",
      event: "knowledge.version_get_failed",
      context: { requestId },
    });
  }
}
