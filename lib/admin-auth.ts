import "server-only";
import { getFirebaseAdminAuth } from "@/lib/firebase-admin";
import {
  getAdminClaims,
  getProtectedAdminEmail,
  isProtectedAdmin,
  normalizeEmail,
  type AdminClaims,
} from "@/lib/admin-common";
import type { DecodedIdToken } from "firebase-admin/auth";

export { getAdminClaims, isProtectedAdmin, normalizeEmail };
export type { AdminClaims };

export class AdminAuthError extends Error {
  constructor(
    message: string,
    public status: number = 403
  ) {
    super(message);
  }
}

export async function verifyAdminIdToken(idToken: string): Promise<DecodedIdToken> {
  const auth = getFirebaseAdminAuth();
  try {
    return await auth.verifyIdToken(idToken, true);
  } catch {
    throw new AdminAuthError("Invalid or expired ID token.", 401);
  }
}

export function assertAnyAdmin(token: DecodedIdToken): void {
  if (!getAdminClaims(token)) {
    throw new AdminAuthError("This action requires administrator access.", 403);
  }
}

export function assertSuperAdmin(token: DecodedIdToken): void {
  const claims = getAdminClaims(token);
  if (!claims || claims.role !== "superadmin") {
    throw new AdminAuthError("This action requires superadmin access.", 403);
  }
}

export function assertBootstrapEligible(token: DecodedIdToken): void {
  if (!token.email_verified) {
    throw new AdminAuthError("Email must be verified to bootstrap admin access.", 403);
  }

  const email = normalizeEmail(token.email);
  const expected = getProtectedAdminEmail();
  if (!expected) {
    throw new AdminAuthError("Super admin bootstrap is not configured.", 500);
  }
  if (email !== expected) {
    throw new AdminAuthError("This account is not eligible for bootstrap access.", 403);
  }
}
