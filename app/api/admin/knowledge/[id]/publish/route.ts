import { type NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logInfo } from "@/lib/log";
import {
  knowledgeActorOf,
  publishKnowledgeArticle,
} from "@/lib/knowledge-admin";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const actor = await requireAdminActor(idToken);
    const { id } = await params;
    const article = await publishKnowledgeArticle(
      decodeURIComponent(id),
      knowledgeActorOf(actor)
    );
    logInfo("knowledge.published", {
      slug: article.slug,
      version: article.version,
      requestId,
    });
    return NextResponse.json({ ok: true, article });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to publish knowledge article.",
      event: "knowledge.publish_failed",
      context: { requestId },
    });
  }
}
