import { type NextRequest, NextResponse } from "next/server";
import {
  assertSuperAdmin,
  isProtectedAdmin,
  normalizeEmail,
  verifyAdminIdToken,
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

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidRole(role: unknown): role is "admin" | "superadmin" {
  return role === "admin" || role === "superadmin";
}

export async function GET(req: NextRequest) {
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const decoded = await verifyAdminIdToken(idToken);
    assertSuperAdmin(decoded);

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
    const message = error instanceof Error ? error.message : "Failed to load administrators.";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function POST(req: NextRequest) {
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequestResponse("Invalid JSON body.");
  }

  try {
    const decoded = await verifyAdminIdToken(idToken);
    assertSuperAdmin(decoded);

    const email = normalizeEmail(String(body.email ?? ""));
    const role = body.role;

    if (!email || !EMAIL_REGEX.test(email)) {
      return badRequestResponse("A valid email address is required.");
    }
    if (!isValidRole(role)) {
      return badRequestResponse("Role must be 'admin' or 'superadmin'.");
    }
    if (isProtectedAdmin(email)) {
      return forbiddenResponse("The protected bootstrap superadmin cannot be invited again.");
    }

    const invitation = await createInvitation(email, role, decoded.uid);

    const emailResult = await sendAdminInvitationEmail(invitation.email, invitation.role);

    let deliveryRecorded = true;
    try {
      await recordInvitationEmailAttempt(
        invitation.id,
        emailResult.ok ? "sent" : "failed",
        emailResult.ok ? emailResult.messageId : undefined
      );
    } catch (recordError) {
      console.error("Failed to record invitation email delivery:", recordError);
      deliveryRecorded = false;
    }

    let view: AdminInvitationView;
    try {
      const updatedInvitation = await getInvitationById(invitation.id);
      view = updatedInvitation
        ? serializeAdminInvitation(updatedInvitation)
        : serializeAdminInvitation(invitation);
    } catch (viewError) {
      console.error("Failed to load invitation after email attempt:", viewError);
      view = serializeAdminInvitation(invitation);
    }

    try {
      await logAdminAudit({
        action: "create_invitation",
        targetEmail: email,
        newRole: role,
        actingUid: decoded.uid,
        actingEmail: normalizeEmail(decoded.email),
        metadata: {
          invitationId: invitation.id,
          emailSent: emailResult.ok,
          messageId: emailResult.ok ? emailResult.messageId : undefined,
          deliveryRecorded,
        },
      });
    } catch (auditError) {
      console.error("Failed to log create_invitation audit:", auditError);
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
    const message = error instanceof Error ? error.message : "Failed to create invitation.";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
