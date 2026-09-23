import { type NextRequest, NextResponse } from "next/server";
import {
  isProtectedAdmin,
  normalizeEmail,
  requireSuperAdminActor,
} from "@/lib/admin-auth";
import { logAdminAudit } from "@/lib/admin-audit";
import { getAdminSiteUrl, sendAdminInvitationEmail } from "@/lib/admin-invitation-email";
import {
  createInvitation,
  getInvitationById,
  listPendingInvitations,
  recordInvitationEmailAttempt,
} from "@/lib/admin-invitations";
import { listAdminUsers } from "@/lib/admin-users";
import {
  serializeAdminInvitation,
  serializeAdminUser,
} from "@/lib/admin-serializers";
import type { AdminInvitationView } from "@/lib/types";
import {
  badRequestResponse,
  forbiddenResponse,
  getBearerToken,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { isValidEmail } from "@/lib/email";
import { getRequestId, logError } from "@/lib/log";

function isValidRole(role: unknown): role is "admin" | "superadmin" {
  return role === "admin" || role === "superadmin";
}

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    await requireSuperAdminActor(idToken);

    const [users, invitations] = await Promise.all([
      listAdminUsers(),
      listPendingInvitations(),
    ]);

    return NextResponse.json({
      ok: true,
      users: users.map(serializeAdminUser),
      invitations: invitations.map(serializeAdminInvitation),
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to load administrators.",
      event: "admin_users.list_failed",
      context: { requestId },
    });
  }
}

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequestResponse("Invalid JSON body.");
  }

  try {
    const actor = await requireSuperAdminActor(idToken);

    const email = normalizeEmail(String(body.email ?? ""));
    const role = body.role;

    if (!email || !isValidEmail(email)) {
      return badRequestResponse("A valid email address is required.");
    }
    if (!isValidRole(role)) {
      return badRequestResponse("Role must be 'admin' or 'superadmin'.");
    }
    if (isProtectedAdmin(email)) {
      return forbiddenResponse("The protected bootstrap superadmin cannot be invited again.");
    }

    const invitation = await createInvitation(email, role, actor.token.uid);

    const emailResult = await sendAdminInvitationEmail(invitation.email, invitation.role);

    let deliveryRecorded = true;
    try {
      await recordInvitationEmailAttempt(
        invitation.id,
        emailResult.ok ? "sent" : "failed",
        emailResult.ok ? emailResult.messageId : undefined
      );
    } catch (recordError) {
      logError("admin_invitation.delivery_record_failed", recordError, {
        invitationId: invitation.id,
        requestId,
      });
      deliveryRecorded = false;
    }

    let view: AdminInvitationView;
    try {
      const updatedInvitation = await getInvitationById(invitation.id);
      view = updatedInvitation
        ? serializeAdminInvitation(updatedInvitation)
        : serializeAdminInvitation(invitation);
    } catch (viewError) {
      logError("admin_invitation.reload_failed", viewError, {
        invitationId: invitation.id,
        requestId,
      });
      view = serializeAdminInvitation(invitation);
    }

    try {
      await logAdminAudit({
        action: "create_invitation",
        targetEmail: email,
        newRole: role,
        actingUid: actor.token.uid,
        actingEmail: normalizeEmail(actor.token.email),
        metadata: {
          invitationId: invitation.id,
          emailSent: emailResult.ok,
          messageId: emailResult.ok ? emailResult.messageId : undefined,
          deliveryRecorded,
        },
      });
    } catch (auditError) {
      logError("admin_invitation.audit_failed", auditError, {
        invitationId: invitation.id,
        requestId,
      });
    }

    const adminUrl = `${getAdminSiteUrl()}/admin`;

    if (emailResult.ok && deliveryRecorded) {
      return NextResponse.json({
        ok: true,
        invitationCreated: true,
        emailSent: true,
        deliveryRecorded: true,
        invitation: view,
        adminUrl,
      });
    }

    if (emailResult.ok && !deliveryRecorded) {
      return NextResponse.json({
        ok: true,
        invitationCreated: true,
        emailSent: true,
        deliveryRecorded: false,
        warning:
          "Invitation created and the email was sent, but the delivery record could not be saved. The invitation is still pending.",
        invitation: view,
        adminUrl,
      });
    }

    return NextResponse.json({
      ok: true,
      invitationCreated: true,
      emailSent: false,
      deliveryRecorded,
      warning:
        "Invitation created, but the email could not be delivered. The invitation remains pending.",
      invitation: view,
      adminUrl,
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to create invitation.",
      event: "admin_users.create_failed",
      context: { requestId },
    });
  }
}
