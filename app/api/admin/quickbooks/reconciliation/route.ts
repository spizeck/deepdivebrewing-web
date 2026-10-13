import { type NextRequest, NextResponse } from "next/server";
import { requireAdminPermission } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import {
  getQboReconLatest,
  runQboReconciliation,
} from "@/lib/qbo-recon";

// Stripe ⇄ QuickBooks reconciliation report (issue #181). Read-only by
// design: GET returns the last persisted run, POST runs a fresh bounded
// scan and stores the snapshot. Neither handler posts, adjusts, or
// deletes anything in QuickBooks — the only write is the report state
// document itself.
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireAdminPermission(idToken, "accounting");
    const run = await getQboReconLatest();
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Could not load the reconciliation report.",
      event: "qbo.recon_get_failed",
      context: { requestId },
    });
  }
}

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const actor = await requireAdminPermission(idToken, "accounting");
    let from: string | undefined;
    let to: string | undefined;
    // An empty body is a default-range run; a JSON body may supply the
    // optional { from, to } window — both are validated downstream.
    const raw = await req.text();
    if (raw.trim()) {
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      if (typeof body === "object" && body !== null) {
        const b = body as Record<string, unknown>;
        if (typeof b.from === "string") from = b.from;
        if (typeof b.to === "string") to = b.to;
      }
    }
    const run = await runQboReconciliation({ actor, from, to });
    return NextResponse.json({ ok: true, run });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "The reconciliation report could not be generated.",
      event: "qbo.recon_run_failed",
      context: { requestId },
    });
  }
}
