import { isProtectedAdmin, normalizeEmail } from "@/lib/admin-common";
import type { AdminRole, AdminStatus } from "@/lib/types";

export interface AdminMutationContext {
  actingUid: string;
  actingRole: AdminRole;
  targetUid: string;
  targetEmail: string;
  targetCurrentRole: AdminRole;
  targetCurrentStatus: AdminStatus;
  desiredRole?: AdminRole;
  desiredStatus?: AdminStatus;
  activeSuperAdminCount: number;
}

export interface AdminMutationResult {
  allowed: boolean;
  reason?: string;
}

export function canModifyAdministrator(ctx: AdminMutationContext): AdminMutationResult {
  if (ctx.actingRole !== "superadmin") {
    return { allowed: false, reason: "Only a superadmin can manage administrator access." };
  }

  if (ctx.actingUid === ctx.targetUid) {
    if (ctx.desiredRole && ctx.desiredRole !== ctx.targetCurrentRole) {
      return { allowed: false, reason: "You cannot change your own role through this interface." };
    }
    if (ctx.desiredStatus && ctx.desiredStatus !== ctx.targetCurrentStatus) {
      return { allowed: false, reason: "You cannot disable or reactivate your own account through this interface." };
    }
  }

  if (isProtectedAdmin(ctx.targetEmail)) {
    if (ctx.desiredRole && ctx.desiredRole !== "superadmin") {
      return { allowed: false, reason: "The bootstrap superadmin cannot be demoted." };
    }
    if (ctx.desiredStatus && ctx.desiredStatus !== "active") {
      return { allowed: false, reason: "The bootstrap superadmin account cannot be disabled." };
    }
  }

  const wouldRemoveSuperadminStatus =
    ctx.targetCurrentRole === "superadmin" &&
    ctx.desiredRole &&
    ctx.desiredRole !== "superadmin";
  const wouldDisableSuperadmin =
    ctx.targetCurrentRole === "superadmin" &&
    ctx.desiredStatus === "disabled";

  if ((wouldRemoveSuperadminStatus || wouldDisableSuperadmin) && ctx.activeSuperAdminCount <= 1) {
    return {
      allowed: false,
      reason: "Cannot remove or disable the last active superadmin.",
    };
  }

  return { allowed: true };
}

export function canRevokeAdministrator(ctx: Omit<AdminMutationContext, "desiredRole" | "desiredStatus">): AdminMutationResult {
  const revokeCheck = canModifyAdministrator({
    ...ctx,
    desiredStatus: "disabled",
  });
  if (!revokeCheck.allowed) return revokeCheck;

  if (isProtectedAdmin(ctx.targetEmail)) {
    return { allowed: false, reason: "The bootstrap superadmin account cannot be revoked." };
  }

  if (ctx.targetCurrentRole === "superadmin" && ctx.activeSuperAdminCount <= 1) {
    return { allowed: false, reason: "Cannot revoke the last active superadmin." };
  }

  return { allowed: true };
}

export function normalizeAdminEmail(email: string | null | undefined): string {
  return normalizeEmail(email);
}

export function isValidAdminRole(role: unknown): role is AdminRole {
  return role === "superadmin" || role === "admin";
}

export function isValidAdminStatus(status: unknown): status is AdminStatus {
  return status === "active" || status === "disabled";
}
