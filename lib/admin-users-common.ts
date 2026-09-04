import { normalizeEmail } from "@/lib/admin-common";
import type { AdminRole, AdminUserRecord } from "@/lib/admin-types";

export function buildDisplayName(displayName?: string): { displayName?: string } {
  const trimmed = displayName?.trim();
  return trimmed ? { displayName: trimmed } : {};
}

export function buildNewAdminUserRecord(
  email: string,
  role: AdminRole,
  actorUid: string,
  now: FirebaseFirestore.Timestamp,
  displayName?: string
): Omit<AdminUserRecord, "uid"> {
  return {
    email: normalizeEmail(email),
    role,
    status: "active",
    createdAt: now,
    createdBy: actorUid,
    updatedAt: now,
    updatedBy: actorUid,
    lastLoginAt: now,
    ...buildDisplayName(displayName),
  };
}

export function buildExistingAdminLoginUpdate(
  existingData: Partial<AdminUserRecord> | undefined,
  actorUid: string,
  now: FirebaseFirestore.Timestamp,
  displayName?: string
): Record<string, unknown> {
  const updatePayload: Record<string, unknown> = {
    lastLoginAt: now,
    updatedAt: now,
    updatedBy: actorUid,
  };

  const incomingName = displayName?.trim();
  const existingName = existingData?.displayName?.trim();
  if (incomingName && !existingName) {
    updatePayload.displayName = incomingName;
  }

  return updatePayload;
}
