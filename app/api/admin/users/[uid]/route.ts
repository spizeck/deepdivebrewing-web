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
} from "@/lib/admin-users";
import type { AdminUserRecord } from "@/lib/admin-types";
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

    // Synchronize custom claims with the resulting role/status. If the claim change
    // fails, roll back the Firestore record so claims and record stay consistent.
    if (desiredRole || desiredStatus) {
      const auth = getFirebaseAdminAuth();
      const resultingStatus = desiredStatus ?? target.status;
      const resultingRole = desiredRole ?? target.role;

      try {
        if (resultingStatus === "disabled") {
          await auth.setCustomUserClaims(targetUid, null);
        } else {
          await auth.setCustomUserClaims(targetUid, { admin: true, role: resultingRole });
        }
      } catch (error) {
        await updateAdminUser(
          targetUid,
          { role: target.role, status: target.status },
          decoded.uid
        );
        throw error;
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
