import { type NextRequest, NextResponse } from "next/server";
import {
  assertSuperAdmin,
  isProtectedAdmin,
  normalizeEmail,
  verifyAdminIdToken,
} from "@/lib/admin-auth";
import { logAdminAudit } from "@/lib/admin-audit";
import {
  createInvitation,
  listPendingInvitations,
} from "@/lib/admin-invitations";
import { listAdminUsers } from "@/lib/admin-users";
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

    return NextResponse.json({ ok: true, users, invitations });
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

    await logAdminAudit({
      action: "create_invitation",
      targetEmail: email,
      newRole: role,
      actingUid: decoded.uid,
      actingEmail: normalizeEmail(decoded.email),
      metadata: { invitationId: invitation.id },
    });

    return NextResponse.json({ ok: true, invitation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create invitation.";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
