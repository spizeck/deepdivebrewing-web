import { type NextRequest, NextResponse } from "next/server";
import {
  assertSuperAdmin,
  normalizeEmail,
  verifyAdminIdToken,
} from "@/lib/admin-auth";
import { logAdminAudit } from "@/lib/admin-audit";
import { getAdminSiteUrl, sendAdminInvitationEmail } from "@/lib/admin-invitation-email";
import {
  getInvitationById,
  recordInvitationEmailAttempt,
} from "@/lib/admin-invitations";
import { canResendInvitation } from "@/lib/admin-invitation-resend-policy";
import { serializeAdminInvitation } from "@/lib/admin-serializers";
import {
  badRequestResponse,
  getBearerToken,
  unauthorizedResponse,
} from "@/lib/api-auth";

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

    const invitation = await getInvitationById(invitationId);
    if (!invitation) {
      return badRequestResponse("Invitation not found.");
    }

    const resendCheck = canResendInvitation(invitation, Date.now());
    if (!resendCheck.ok) {
      return NextResponse.json(
        { ok: false, error: resendCheck.reason },
        { status: 429 }
      );
    }

    const emailResult = await sendAdminInvitationEmail(invitation.email, invitation.role);

    await recordInvitationEmailAttempt(
      invitation.id,
      emailResult.ok ? "sent" : "failed",
      emailResult.ok ? emailResult.messageId : undefined
    );

    if (emailResult.ok) {
      await logAdminAudit({
        action: "resend_invitation",
        targetEmail: normalizeEmail(invitation.email),
        newRole: invitation.role,
        actingUid: decoded.uid,
        actingEmail: normalizeEmail(decoded.email),
        metadata: {
          invitationId: invitation.id,
          messageId: emailResult.messageId,
        },
      });

      return NextResponse.json({
        ok: true,
        emailResent: true,
        invitation: serializeAdminInvitation(
          (await getInvitationById(invitation.id)) ?? invitation
        ),
        adminUrl: `${getAdminSiteUrl()}/admin`,
      });
    }

    console.error("Resend invitation failed:", emailResult.error);

    return NextResponse.json({
      ok: true,
      emailResent: false,
      warning:
        "The email could not be resent. The invitation remains pending.",
      invitation: serializeAdminInvitation(
        (await getInvitationById(invitation.id)) ?? invitation
      ),
      adminUrl: `${getAdminSiteUrl()}/admin`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resend invitation.";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
