import { type NextRequest, NextResponse } from "next/server";
import {
  isProtectedAdmin,
  normalizeEmail,
  verifyAdminIdToken,
} from "@/lib/admin-auth";
import { getFirebaseAdminAuth, getFirebaseAdminDb } from "@/lib/firebase-admin";
import { logAdminAudit } from "@/lib/admin-audit";
import { getPendingInvitationByEmail } from "@/lib/admin-invitations";
import { getAdminUser } from "@/lib/admin-users";
import {
  evaluateInvitationAcceptance,
  type InvitationAcceptanceCheck,
} from "@/lib/admin-invitation-policy";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { Timestamp } from "firebase-admin/firestore";

export async function POST(req: NextRequest) {
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const decoded = await verifyAdminIdToken(idToken);
    const email = normalizeEmail(decoded.email);
    const invitation = await getPendingInvitationByEmail(email);
    const existingRecord = await getAdminUser(decoded.uid);

    const check: InvitationAcceptanceCheck = {
      existingRecord,
      invitation,
      existingClaims: null,
      isProtectedEmail: isProtectedAdmin(email),
      isEmailVerified: !!decoded.email_verified,
    };

    const result = evaluateInvitationAcceptance(check);

    if (result.decision === "reject") {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }

    const auth = getFirebaseAdminAuth();
    const db = getFirebaseAdminDb();

    if (result.idempotent && existingRecord) {
      // Re-sync claims with the existing active record and consume the invitation.
      await auth.setCustomUserClaims(decoded.uid, {
        admin: true,
        role: existingRecord.role,
      });
      await markInvitationAcceptedSafely(invitation!.id, decoded.uid);

      await logAdminAudit({
        action: "accept_invitation",
        targetUid: decoded.uid,
        targetEmail: email,
        newRole: existingRecord.role,
        newStatus: "active",
        actingUid: decoded.uid,
        actingEmail: email,
        metadata: { invitationId: invitation!.id, idempotent: true },
      });

      return NextResponse.json({
        ok: true,
        message: "Invitation accepted. Sign out and sign back in to refresh your session.",
        uid: decoded.uid,
        role: existingRecord.role,
      });
    }

    // No existing record: create a synchronized adminUsers record and mark the
    // invitation accepted in a single Firestore transaction, then set claims.
    await db.runTransaction(async (transaction) => {
      const invitationRef = db.collection("adminInvitations").doc(invitation!.id);
      const userRef = db.collection("adminUsers").doc(decoded.uid);
      const now = Timestamp.now();

      const userRecord = {
        email,
        role: result.role,
        status: "active",
        createdAt: now,
        createdBy: decoded.uid,
        updatedAt: now,
        updatedBy: decoded.uid,
        lastLoginAt: now,
        ...(decoded.name ? { displayName: decoded.name } : {}),
      };

      transaction.set(userRef, userRecord);
      transaction.update(invitationRef, {
        status: "accepted",
        acceptedAt: now,
        acceptedBy: decoded.uid,
      });
    });

    try {
      await auth.setCustomUserClaims(decoded.uid, {
        admin: true,
        role: result.role,
      });
    } catch (error) {
      // Best-effort rollback: without working claims the active record should not
      // remain, so delete the record and revert the invitation to pending.
      try {
        await db.collection("adminUsers").doc(decoded.uid).delete();
        await db.collection("adminInvitations").doc(invitation!.id).update({
          status: "pending",
          acceptedAt: null,
          acceptedBy: null,
        });
      } catch (rollbackError) {
        console.error("Failed to rollback invitation acceptance:", rollbackError);
      }
      throw error;
    }

    await logAdminAudit({
      action: "accept_invitation",
      targetUid: decoded.uid,
      targetEmail: email,
      newRole: result.role,
      newStatus: "active",
      actingUid: decoded.uid,
      actingEmail: email,
      metadata: { invitationId: invitation!.id },
    });

    return NextResponse.json({
      ok: true,
      message: "Invitation accepted. Sign out and sign back in to refresh your session.",
      uid: decoded.uid,
      role: result.role,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to accept invitation.";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

async function markInvitationAcceptedSafely(invitationId: string, acceptedByUid: string) {
  const db = getFirebaseAdminDb();
  await db.collection("adminInvitations").doc(invitationId).update({
    status: "accepted",
    acceptedAt: Timestamp.now(),
    acceptedBy: acceptedByUid,
  });
}
