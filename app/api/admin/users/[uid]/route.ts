import { type NextRequest, NextResponse } from "next/server";
import {
  assertSuperAdmin,
  getAdminClaims,
  normalizeEmail,
  verifyAdminIdToken,
} from "@/lib/admin-auth";
import { getFirebaseAdminAuth } from "@/lib/firebase-admin";
import { logAdminAudit } from "@/lib/admin-audit";
import {
  countActiveSuperAdmins,
  getAdminUser,
  updateAdminUser,
  type AdminUserRecord,
} from "@/lib/admin-users";
import {
  badRequestResponse,
  getBearerToken,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { canModifyAdministrator, canRevokeAdministrator, isValidAdminRole, isValidAdminStatus } from "@/lib/admin-policy";

interface RouteParams {
  params: Promise<{ uid: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequestResponse("Invalid JSON body.");
  }

  try {
    const { uid: targetUid } = await params;
    const decoded = await verifyAdminIdToken(idToken);
    assertSuperAdmin(decoded);

    const actingClaims = getAdminClaims(decoded)!;
    const target = await getAdminUser(targetUid);
    if (!target) {
      return badRequestResponse("Administrator record not found.");
    }

    const desiredRole =
      body.role !== undefined && isValidAdminRole(body.role) ? body.role : undefined;
    const desiredStatus =
      body.status !== undefined && isValidAdminStatus(body.status) ? body.status : undefined;

    if (!desiredRole && !desiredStatus && body.displayName === undefined) {
      return badRequestResponse("No valid fields provided to update.");
    }

    if (desiredRole || desiredStatus) {
      const activeSuperAdminCount = target.role === "superadmin" && target.status === "active"
        ? await countActiveSuperAdmins()
        : await countActiveSuperAdmins();

      const mutation = canModifyAdministrator({
        actingUid: decoded.uid,
        actingRole: actingClaims.role,
        targetUid: target.uid,
        targetEmail: target.email,
        targetCurrentRole: target.role,
        targetCurrentStatus: target.status,
        desiredRole,
        desiredStatus,
        activeSuperAdminCount,
      });

      if (!mutation.allowed) {
        return NextResponse.json({ ok: false, error: mutation.reason }, { status: 403 });
      }
    }

    const updates: Partial<Pick<AdminUserRecord, "displayName" | "role" | "status">> = {};
    if (body.displayName !== undefined) {
      updates.displayName = String(body.displayName);
    }
    if (desiredRole) updates.role = desiredRole;
    if (desiredStatus) updates.status = desiredStatus;

    await updateAdminUser(targetUid, updates, decoded.uid);

    // Update custom claims when role or status changes.
    const auth = getFirebaseAdminAuth();
    if (desiredRole || desiredStatus) {
      if (desiredStatus === "disabled" || desiredRole === undefined) {
        // Keep current role in record but remove privileged claims when disabled.
        // If desiredRole is admin and status active, set admin true.
        if (desiredStatus === "disabled") {
          await auth.setCustomUserClaims(targetUid, null);
        }
      }
      if (desiredStatus !== "disabled" && desiredRole) {
        await auth.setCustomUserClaims(targetUid, { admin: true, role: desiredRole });
      }
    }

    await logAdminAudit({
      action: "update_admin",
      targetUid: target.uid,
      targetEmail: normalizeEmail(target.email),
      oldRole: target.role,
      newRole: desiredRole ?? target.role,
      oldStatus: target.status,
      newStatus: desiredStatus ?? target.status,
      actingUid: decoded.uid,
      actingEmail: normalizeEmail(decoded.email),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update administrator.";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const { uid: targetUid } = await params;
    const decoded = await verifyAdminIdToken(idToken);
    assertSuperAdmin(decoded);

    const actingClaims = getAdminClaims(decoded)!;
    const target = await getAdminUser(targetUid);
    if (!target) {
      return badRequestResponse("Administrator record not found.");
    }

    const activeSuperAdminCount = await countActiveSuperAdmins();
    const mutation = canRevokeAdministrator({
      actingUid: decoded.uid,
      actingRole: actingClaims.role,
      targetUid: target.uid,
      targetEmail: target.email,
      targetCurrentRole: target.role,
      targetCurrentStatus: target.status,
      activeSuperAdminCount,
    });

    if (!mutation.allowed) {
      return NextResponse.json({ ok: false, error: mutation.reason }, { status: 403 });
    }

    const auth = getFirebaseAdminAuth();
    await auth.setCustomUserClaims(targetUid, null);
    await auth.revokeRefreshTokens(targetUid);
    await updateAdminUser(targetUid, { status: "disabled" }, decoded.uid);

    await logAdminAudit({
      action: "revoke_admin",
      targetUid: target.uid,
      targetEmail: normalizeEmail(target.email),
      oldRole: target.role,
      oldStatus: target.status,
      newStatus: "disabled",
      actingUid: decoded.uid,
      actingEmail: normalizeEmail(decoded.email),
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to revoke administrator access.";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
