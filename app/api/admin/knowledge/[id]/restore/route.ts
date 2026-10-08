import { type NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import {
  badRequestResponse,
  getBearerToken,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo } from "@/lib/log";
import {
  knowledgeActorOf,
  restoreKnowledgeVersion,
} from "@/lib/knowledge-admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

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

  const versionId =
    typeof body === "object" && body !== null && "versionId" in body
      ? String((body as { versionId: unknown }).versionId)
      : "";
  if (!/^v\d{3,}$/.test(versionId)) {
    return badRequestResponse("A valid versionId (e.g. v001) is required.");
  }

  try {
    const actor = await requireAdminActor(idToken);
    const { id } = await params;
    const article = await restoreKnowledgeVersion(
      decodeURIComponent(id),
      versionId,
      knowledgeActorOf(actor)
    );
    logInfo("knowledge.restored", {
      slug: article.slug,
      versionId,
      requestId,
    });
    return NextResponse.json({ ok: true, article });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to restore knowledge version.",
      event: "knowledge.restore_failed",
      context: { requestId },
    });
  }
}
