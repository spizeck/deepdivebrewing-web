import { type NextRequest, NextResponse } from "next/server";
import {
  normalizeEmail,
  requireSuperAdminActor,
} from "@/lib/admin-auth";
import { logAdminAudit } from "@/lib/admin-audit";
import {
  getAdminSiteUrl,
  sendAdminInvitationEmail,
} from "@/lib/admin-invitation-email";
import { runResendInvitationCore } from "@/lib/admin-invitation-resend-core";
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
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logError } from "@/lib/log";
import { Timestamp } from "firebase-admin/firestore";
import type { AdminInvitation } from "@/lib/admin-types";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function mergeLatestEmailFields(
  invitation: AdminInvitation,
  emailSent: boolean,
  messageId?: string
): AdminInvitation {
  return {
    ...invitation,
    emailStatus: emailSent ? "sent" : "failed",
    lastEmailAttemptAt: new Date() as unknown as AdminInvitation["lastEmailAttemptAt"],
    messageId: emailSent ? messageId : undefined,
  };
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const { id: invitationId } = await params;
    const actor = await requireSuperAdminActor(idToken);

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
    const adminUrl = `${getAdminSiteUrl()}/admin`;

    const coreResult = await runResendInvitationCore({
      invitation,
      sendEmail: sendAdminInvitationEmail,
      recordDelivery: (id, status, messageId) =>
        recordInvitationEmailAttempt(id, status, messageId),
      audit: (metadata) =>
        logAdminAudit({
          action: "resend_invitation",
          targetEmail: normalizeEmail(invitation.email),
          newRole: invitation.role,
          actingUid: actor.token.uid,
          actingEmail: normalizeEmail(actor.token.email),
          metadata,
        }),
      logError: (message, error) =>
        logError("admin_invitation.resend_step_failed", error, {
          step: message,
          invitationId: invitation.id,
          requestId,
        }),
    });

    let updatedInvitation: AdminInvitation | null = null;
    try {
      updatedInvitation = await getInvitationById(invitation.id);
    } catch (viewError) {
      logError("admin_invitation.reload_failed", viewError, {
        invitationId: invitation.id,
        requestId,
      });
    }

    const view = updatedInvitation
      ? serializeAdminInvitation(updatedInvitation)
      : serializeAdminInvitation(
          mergeLatestEmailFields(
            invitation,
            coreResult.emailSent,
            coreResult.messageId
          )
        );

    return NextResponse.json({
      ok: true,
      emailResent: coreResult.emailSent,
      deliveryRecorded: coreResult.deliveryRecorded,
      ...(coreResult.warning ? { warning: coreResult.warning } : {}),
      invitation: view,
      adminUrl,
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to resend invitation.",
      event: "admin_invitation.resend_failed",
      context: { requestId },
    });
  }
}
