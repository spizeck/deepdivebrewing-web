import "server-only";
import { getFirebaseAdminAuth } from "@/lib/firebase-admin";
import {
  getAdminClaims,
  getProtectedAdminEmail,
  isProtectedAdmin,
  normalizeEmail,
  type AdminClaims,
} from "@/lib/admin-common";
import { checkAdminActorRecord } from "@/lib/admin-policy";
import { getAdminUser } from "@/lib/admin-users";
import type { AdminUserRecord } from "@/lib/admin-types";
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

export interface AdminActor {
  token: DecodedIdToken;
  claims: AdminClaims;
  record: AdminUserRecord;
}

async function resolveActiveAdminActor(token: DecodedIdToken): Promise<AdminActor> {
  const claims = getAdminClaims(token);
  if (!claims) {
    throw new AdminAuthError("This action requires administrator access.", 403);
  }

  const record = await getAdminUser(token.uid);
  const check = checkAdminActorRecord({ claims, record });
  if (!check.allowed) {
    throw new AdminAuthError(check.error, 403);
  }

  return { token, claims, record: record! };
}

// Central per-request authorization for privileged routes: verified ID token,
// valid admin claim, and an existing, active adminUsers record whose role
// matches the claims. Future protected routes should use these helpers rather
// than re-checking claims alone.
export async function requireAdminActor(idToken: string): Promise<AdminActor> {
  const token = await verifyAdminIdToken(idToken);
  assertAnyAdmin(token);
  return resolveActiveAdminActor(token);
}

export async function requireSuperAdminActor(idToken: string): Promise<AdminActor> {
  const token = await verifyAdminIdToken(idToken);
  assertSuperAdmin(token);
  return resolveActiveAdminActor(token);
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
