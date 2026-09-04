import { type NextRequest, NextResponse } from "next/server";
import {
  assertSuperAdmin,
  normalizeEmail,
  verifyAdminIdToken,
} from "@/lib/admin-auth";
import { logAdminAudit } from "@/lib/admin-audit";
import {
  getAdminSiteUrl,
  sendAdminInvitationEmail,
} from "@/lib/admin-invitation-email";
import {
  getInvitationById,
  recordInvitationEmailAttempt,
} from "@/lib/admin-invitations";
import { canResendInvitation } from "@/lib/admin-invitation-resend-policy";
import { getFirebaseAdminDb } from "@/lib/firebase-admin";
import { serializeAdminInvitation } from "@/lib/admin-serializers";
import {
  badRequestResponse,
  getBearerToken,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { Timestamp } from "firebase-admin/firestore";
import type { AdminInvitation } from "@/lib/admin-types";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const { id: invitationId } = await params;
    const decoded = await verifyAdminIdToken(idToken);
    assertSuperAdmin(decoded);

    const db = getFirebaseAdminDb();
    const invitationRef = db.collection("adminInvitations").doc(invitationId);

    const claim = await db.runTransaction(async (t) => {
      const snap = await t.get(invitationRef);
      if (!snap.exists) {
        return {
          ok: false as const,
          reason: "Invitation not found.",
          currentStatus: "",
        };
      }

      const current = {
        id: snap.id,
        ...(snap.data() as Omit<AdminInvitation, "id">),
      };

      const resendCheck = canResendInvitation(current, Date.now());
      if (!resendCheck.ok) {
        return {
          ok: false as const,
          reason: resendCheck.reason ?? "Resend not allowed.",
          currentStatus: current.status,
        };
      }

      // Claim the send attempt before calling Resend so concurrent resend
      // requests cannot pass the cooldown check simultaneously.
      t.update(invitationRef, {
        lastEmailAttemptAt: Timestamp.now(),
      });

      return { ok: true as const, invitation: current };
    });

    if (!claim.ok) {
      if (claim.reason === "Invitation not found.") {
        return badRequestResponse(claim.reason);
      }
      const status = claim.currentStatus !== "pending" ? 409 : 429;
      return NextResponse.json(
        { ok: false, error: claim.reason },
        { status }
      );
    }

    const { invitation } = claim;
    const emailResult = await sendAdminInvitationEmail(invitation.email, invitation.role);

    await recordInvitationEmailAttempt(
      invitation.id,
      emailResult.ok ? "sent" : "failed",
      emailResult.ok ? emailResult.messageId : undefined
    );

    await logAdminAudit({
      action: "resend_invitation",
      targetEmail: normalizeEmail(invitation.email),
      newRole: invitation.role,
      actingUid: decoded.uid,
      actingEmail: normalizeEmail(decoded.email),
      metadata: {
        invitationId: invitation.id,
        emailSent: emailResult.ok,
        messageId: emailResult.ok ? emailResult.messageId : undefined,
        error: emailResult.ok ? undefined : emailResult.error,
      },
    }).catch((auditError) => {
      console.error("Failed to log resend_invitation audit:", auditError);
    });

    const updatedInvitation = await getInvitationById(invitation.id);
    const view = updatedInvitation
      ? serializeAdminInvitation(updatedInvitation)
      : serializeAdminInvitation(invitation);

    if (emailResult.ok) {
      return NextResponse.json({
        ok: true,
        emailResent: true,
        invitation: view,
        adminUrl: `${getAdminSiteUrl()}/admin`,
      });
    }

    return NextResponse.json({
      ok: true,
      emailResent: false,
      warning:
        "The email could not be resent. The invitation remains pending.",
      invitation: view,
      adminUrl: `${getAdminSiteUrl()}/admin`,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to resend invitation.";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
