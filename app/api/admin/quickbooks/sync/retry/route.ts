import { type NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import {
  badRequestResponse,
  getBearerToken,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { requeueQboSyncRecord } from "@/lib/qbo-sync-admin";

// Manual retry for a single sync record (issue #183): an admin requeues
// a `failed`/`needs_attention` record once its cause is fixed. The record
// returns to `pending` with a fresh attempt budget and is processed
// inline — every worker gate (canonical Stripe verification, mapping,
// environment/realm binding, idempotency) still applies.
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const actor = await requireAdminActor(idToken);
    const body = (await req.json().catch(() => ({}))) as {
      syncId?: unknown;
    };
    if (typeof body.syncId !== "string" || !body.syncId.trim()) {
      return badRequestResponse("A syncId is required.");
    }
    const result = await requeueQboSyncRecord(actor, body.syncId.trim());
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "The sync record could not be requeued.",
      event: "qbo.sync_requeue_failed",
      context: { requestId },
    });
  }
}
