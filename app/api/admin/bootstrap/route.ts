import { type NextRequest, NextResponse } from "next/server";
import {
  assertBootstrapEligible,
  getAdminClaims,
  normalizeEmail,
} from "@/lib/admin-auth";
import { getFirebaseAdminAuth } from "@/lib/firebase-admin";
import { logAdminAudit } from "@/lib/admin-audit";
import { ensureAdminUser } from "@/lib/admin-users";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  const idToken = getBearerToken(req);
  if (!idToken) {
    return unauthorizedResponse("Missing bearer token.");
  }

  try {
    const auth = getFirebaseAdminAuth();
    const decoded = await auth.verifyIdToken(idToken, true);
    assertBootstrapEligible(decoded);

    // Idempotent: only set claims if not already a superadmin.
    const existingClaims = getAdminClaims(decoded);
    if (!existingClaims || existingClaims.role !== "superadmin") {
      await auth.setCustomUserClaims(decoded.uid, {
        admin: true,
        role: "superadmin",
      });
    }

    const record = await ensureAdminUser(
      decoded.uid,
      decoded.email!,
      "superadmin",
      decoded.uid,
      decoded.name
    );

    await logAdminAudit({
      action: "bootstrap",
      targetUid: decoded.uid,
      targetEmail: normalizeEmail(decoded.email),
      newRole: "superadmin",
      newStatus: "active",
      actingUid: decoded.uid,
      actingEmail: normalizeEmail(decoded.email),
      metadata: { tokenClaimsUpdated: existingClaims?.role !== "superadmin" },
    });

    return NextResponse.json({
      ok: true,
      message: "Bootstrap superadmin access granted. Sign out and sign back in to refresh your session.",
      uid: record.uid,
      role: record.role,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to bootstrap admin access.";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
