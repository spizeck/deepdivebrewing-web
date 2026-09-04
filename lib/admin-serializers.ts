import type { AdminUserRecord, AdminInvitation } from "@/lib/admin-types";
import type { AdminUserView, AdminInvitationView } from "@/lib/types";

interface TimestampLike {
  toDate(): Date;
}

function isTimestampLike(value: unknown): value is TimestampLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as { toDate: unknown }).toDate === "function"
  );
}

function toIsoString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (isTimestampLike(value)) return value.toDate().toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

export function serializeAdminUser(record: AdminUserRecord): AdminUserView {
  return {
    uid: record.uid,
    email: record.email,
    displayName: record.displayName,
    role: record.role,
    status: record.status,
    createdAt: toIsoString(record.createdAt) ?? "",
    createdBy: record.createdBy,
    updatedAt: toIsoString(record.updatedAt),
    updatedBy: record.updatedBy,
    lastLoginAt: toIsoString(record.lastLoginAt),
  };
}

export function serializeAdminInvitation(
  record: AdminInvitation
): AdminInvitationView {
  return {
    id: record.id,
    email: record.email,
    role: record.role,
    status: record.status,
    invitedBy: record.invitedBy,
    createdAt: toIsoString(record.createdAt) ?? "",
    acceptedAt: toIsoString(record.acceptedAt),
    acceptedBy: record.acceptedBy,
    emailStatus: record.emailStatus,
    lastEmailAttemptAt: toIsoString(record.lastEmailAttemptAt),
    messageId: record.messageId,
  };
}
