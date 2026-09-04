import type { AdminRole } from "@/lib/types";
import type { DecodedIdToken } from "firebase-admin/auth";

export interface AdminClaims {
  admin: true;
  role: AdminRole;
}

export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function getAdminClaims(token: DecodedIdToken): AdminClaims | null {
  if (token.admin === true && (token.role === "superadmin" || token.role === "admin")) {
    return { admin: true, role: token.role };
  }
  return null;
}

export function isAdmin(token: DecodedIdToken): boolean {
  return getAdminClaims(token) !== null;
}

export function isSuperAdmin(token: DecodedIdToken): boolean {
  return getAdminClaims(token)?.role === "superadmin";
}

export function getProtectedAdminEmail(): string | undefined {
  return process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
}

export function isProtectedAdmin(email: string | null | undefined): boolean {
  const protectedEmail = getProtectedAdminEmail();
  if (!protectedEmail) return false;
  return normalizeEmail(email) === protectedEmail;
}
