import { type NextRequest, NextResponse } from "next/server";
import {
  assertBootstrapEligible,
  getAdminClaims,
  normalizeEmail,
} from "@/lib/admin-auth";
import { getFirebaseAdminAuth } from "@/lib/firebase-admin";
import { logAdminAudit } from "@/lib/admin-audit";
import { ensureAdminUser, updateAdminUser } from "@/lib/admin-users";
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

    // Determine whether we need to update claims so we can roll back on Firestore failure.
    const existingClaims = getAdminClaims(decoded);
    const claimsNeedUpdate = !existingClaims || existingClaims.role !== "superadmin";

    if (claimsNeedUpdate) {
      await auth.setCustomUserClaims(decoded.uid, {
        admin: true,
        role: "superadmin",
      });
    }

    try {
      // Create the record if it does not exist, then explicitly reconcile it to
      // active superadmin in case a previous partial migration left it stale.
      await ensureAdminUser(
        decoded.uid,
        decoded.email!,
        "superadmin",
        decoded.uid,
        decoded.name
      );
      await updateAdminUser(
        decoded.uid,
        { role: "superadmin", status: "active" },
        decoded.uid
      );
    } catch (error) {
      // Roll back the claim change if the record could not be reconciled, so
      // we do not grant access without a corresponding adminUsers record.
      await auth.setCustomUserClaims(decoded.uid, existingClaims ?? null);
      throw error;
    }

    await logAdminAudit({
      action: "bootstrap",
      targetUid: decoded.uid,
      targetEmail: normalizeEmail(decoded.email),
      newRole: "superadmin",
      newStatus: "active",
      actingUid: decoded.uid,
      actingEmail: normalizeEmail(decoded.email),
      metadata: { tokenClaimsUpdated: claimsNeedUpdate },
    });

    return NextResponse.json({
      ok: true,
      message: "Bootstrap superadmin access granted. Sign out and sign back in to refresh your session.",
      uid: decoded.uid,
      role: "superadmin",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to bootstrap admin access.";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
