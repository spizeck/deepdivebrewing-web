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
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";

// Lifecycle exception: this route intentionally does NOT require an existing
// active adminUsers record — its purpose is to create/reconcile the very first
// superadmin record. Authorization is the verified-email + SUPER_ADMIN_EMAIL
// match in assertBootstrapEligible instead.
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
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
    return apiErrorResponse(error, {
      fallback: "Failed to bootstrap admin access.",
      event: "admin_bootstrap.failed",
      context: { requestId },
    });
  }
}
