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
  deleteKnowledgeAttachment,
  listKnowledgeAttachments,
} from "@/lib/knowledge-admin";
import {
  isKnowledgeAttachmentName,
  isKnowledgeSlug,
} from "@/lib/knowledge-common";

/**
 * Attachment management for one article (#205): listing and deleting the
 * Storage objects under knowledge/<slug>/. These run through the Admin SDK
 * (not the client SDK) so the delete guard can read the article document and
 * its version-history snapshots, which are deny-all to browser access.
 * Deletion is blocked when any stored body still references the object.
 */

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
    if (!isKnowledgeSlug(id)) {
      return badRequestResponse("Invalid article slug.");
    }
    const attachments = await listKnowledgeAttachments(id);
    return NextResponse.json({ ok: true, attachments });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to list attachments.",
      event: "knowledge.attachments_list_failed",
      context: { requestId },
    });
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
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
    await requireAdminActor(idToken);
    const { id } = await params;
    if (!isKnowledgeSlug(id)) {
      return badRequestResponse("Invalid article slug.");
    }
    const name = (body as { name?: unknown } | null)?.name;
    if (typeof name !== "string" || !isKnowledgeAttachmentName(name)) {
      return badRequestResponse("Invalid attachment name.");
    }
    await deleteKnowledgeAttachment(id, name);
    logInfo("knowledge.attachment_deleted", { slug: id, name, requestId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to delete attachment.",
      event: "knowledge.attachment_delete_failed",
      context: { requestId },
    });
  }
}
