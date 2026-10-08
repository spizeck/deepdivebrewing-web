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
  getKnowledgeArticle,
  knowledgeActorOf,
  updateKnowledgeArticle,
} from "@/lib/knowledge-admin";
import { parseKnowledgeInput } from "@/lib/knowledge-common";

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
    const article = await getKnowledgeArticle(decodeURIComponent(id));
    return NextResponse.json({ ok: true, article });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to load knowledge article.",
      event: "knowledge.get_failed",
      context: { requestId },
    });
  }
}

export async function PUT(req: NextRequest, { params }: RouteParams) {
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
    const parsed = parseKnowledgeInput(body);
    if (!parsed.ok) return badRequestResponse(parsed.error);

    const article = await updateKnowledgeArticle(
      decodeURIComponent(id),
      parsed.input,
      knowledgeActorOf(actor)
    );
    logInfo("knowledge.updated", { slug: article.slug, requestId });
    return NextResponse.json({ ok: true, article });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to update knowledge article.",
      event: "knowledge.update_failed",
      context: { requestId },
    });
  }
}
