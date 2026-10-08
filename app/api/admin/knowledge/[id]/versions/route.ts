import { type NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { listKnowledgeVersions } from "@/lib/knowledge-admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminActor(idToken);
    const { id } = await params;
    const versions = await listKnowledgeVersions(decodeURIComponent(id));
    // List payload excludes the body snapshot — the detail route serves it.
    const list = versions.map(({ snapshot: _snapshot, ...meta }) => ({
      ...meta,
      snapshotTitle: _snapshot.title,
      snapshotSummary: _snapshot.summary,
    }));
    return NextResponse.json({ ok: true, versions: list });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to load knowledge versions.",
      event: "knowledge.versions_failed",
      context: { requestId },
    });
  }
}
