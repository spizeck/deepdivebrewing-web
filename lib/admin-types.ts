import type { Timestamp } from "firebase-admin/firestore";

export type AdminRole = "superadmin" | "admin";
export type AdminStatus = "active" | "disabled";

export interface AdminUserRecord {
  uid: string;
  email: string;
  displayName?: string;
  role: AdminRole;
  status: AdminStatus;
  createdAt: Timestamp;
  createdBy?: string;
  updatedAt?: Timestamp;
  updatedBy?: string;
  lastLoginAt?: Timestamp;
}

export interface AdminInvitation {
  id: string;
  email: string;
  role: AdminRole;
  status: "pending" | "accepted" | "cancelled";
  invitedBy: string;
  createdAt: Timestamp;
  acceptedAt?: Timestamp;
  acceptedBy?: string;
}

export interface AdminAuditRecord {
  action:
    | "bootstrap"
    | "accept_invitation"
    | "create_invitation"
    | "cancel_invitation"
    | "update_admin"
    | "revoke_admin"
    | "refresh_claims";
  targetUid?: string;
  targetEmail?: string;
  oldRole?: AdminRole | null;
  newRole?: AdminRole | null;
  oldStatus?: AdminStatus | null;
  newStatus?: AdminStatus | null;
  actingUid: string;
  actingEmail?: string;
  metadata?: Record<string, unknown>;
  timestamp: Timestamp;
}
