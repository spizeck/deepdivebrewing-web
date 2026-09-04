import { type NextRequest, NextResponse } from "next/server";
import {
  getAdminClaims,
  isProtectedAdmin,
  normalizeEmail,
  verifyAdminIdToken,
} from "@/lib/admin-auth";
import { getFirebaseAdminAuth } from "@/lib/firebase-admin";
import { logAdminAudit } from "@/lib/admin-audit";
import {
  getPendingInvitationByEmail,
  markInvitationAccepted,
} from "@/lib/admin-invitations";
import { ensureAdminUser } from "@/lib/admin-users";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";

export async function POST(req: NextRequest) {
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const decoded = await verifyAdminIdToken(idToken);

    if (!decoded.email_verified) {
      return NextResponse.json(
        { ok: false, error: "Email must be verified to accept an invitation." },
        { status: 403 }
      );
    }

    const existingClaims = getAdminClaims(decoded);
    if (existingClaims) {
      return NextResponse.json(
        { ok: false, error: "This account already has administrator access." },
        { status: 400 }
      );
    }

    const email = normalizeEmail(decoded.email);
    const invitation = await getPendingInvitationByEmail(email);
    if (!invitation) {
      return NextResponse.json(
        { ok: false, error: "No pending invitation was found for this account." },
        { status: 404 }
      );
    }

    if (isProtectedAdmin(email)) {
      return NextResponse.json(
        { ok: false, error: "This account cannot accept an invitation." },
        { status: 403 }
      );
    }

    const auth = getFirebaseAdminAuth();
    await auth.setCustomUserClaims(decoded.uid, {
      admin: true,
      role: invitation.role,
    });

    let record;
    try {
      record = await ensureAdminUser(
        decoded.uid,
        decoded.email!,
        invitation.role,
        decoded.uid,
        decoded.name
      );
      await markInvitationAccepted(invitation.id, decoded.uid);
    } catch (error) {
      // Roll back the claim change if we could not create the record or mark the
      // invitation accepted, so access is not granted without a matching record.
      await auth.setCustomUserClaims(decoded.uid, null);
      throw error;
    }

    await logAdminAudit({
      action: "accept_invitation",
      targetUid: decoded.uid,
      targetEmail: email,
      newRole: invitation.role,
      newStatus: "active",
      actingUid: decoded.uid,
      actingEmail: email,
      metadata: { invitationId: invitation.id },
    });

    return NextResponse.json({
      ok: true,
      message: "Invitation accepted. Sign out and sign back in to refresh your session.",
      uid: record.uid,
      role: record.role,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to accept invitation.";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
