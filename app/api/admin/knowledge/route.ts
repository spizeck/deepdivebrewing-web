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
  createKnowledgeArticle,
  knowledgeActorOf,
  listKnowledgeSummaries,
  searchKnowledge,
} from "@/lib/knowledge-admin";
import { parseKnowledgeInput } from "@/lib/knowledge-common";

// GET: ?q=<text> runs the bounded server-side search; without it returns the
// summary list (no article bodies) for the landing page and left nav.
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminActor(idToken);
    const queryText = req.nextUrl.searchParams.get("q")?.trim() ?? "";
    if (queryText) {
      const results = await searchKnowledge(queryText);
      return NextResponse.json({ ok: true, results });
    }
    const articles = await listKnowledgeSummaries();
    return NextResponse.json({ ok: true, articles });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to load knowledge articles.",
      event: "knowledge.list_failed",
      context: { requestId },
    });
  }
}

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

  try {
    const actor = await requireAdminActor(idToken);
    const parsed = parseKnowledgeInput(body);
    if (!parsed.ok) return badRequestResponse(parsed.error);

    const article = await createKnowledgeArticle(
      parsed.input,
      knowledgeActorOf(actor)
    );
    logInfo("knowledge.created", { slug: article.slug, requestId });
    return NextResponse.json({ ok: true, article });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to create knowledge article.",
      event: "knowledge.create_failed",
      context: { requestId },
    });
  }
}
