import type { Timestamp } from "firebase-admin/firestore";
import type { AdminPermission } from "@/lib/admin-permissions";

export type AdminRole = "superadmin" | "admin";
export type AdminStatus = "active" | "disabled";

export interface AdminUserRecord {
  uid: string;
  email: string;
  displayName?: string;
  role: AdminRole;
  status: AdminStatus;
  // Explicit capability grants for sensitive admin surfaces (issue #210).
  // Absent/empty means none; superadmins hold every permission implicitly —
  // see lib/admin-permissions.ts for the authorization contract.
  permissions?: AdminPermission[];
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
  emailStatus?: "pending" | "sent" | "failed";
  lastEmailAttemptAt?: Timestamp;
  messageId?: string;
}

export interface AdminAuditRecord {
  action:
    | "bootstrap"
    | "accept_invitation"
    | "create_invitation"
    | "resend_invitation"
    | "cancel_invitation"
    | "update_admin"
    | "revoke_admin"
    | "refresh_claims"
    // QuickBooks Online integration lifecycle (issue #161). Metadata carries
    // environment/outcome only — never token material or provider payloads.
    | "qbo_connected"
    | "qbo_disconnected"
    | "qbo_connection_checked"
    | "qbo_mapping_updated"
    // Sync operations (issue #183): manual admin requeue of a failed /
    // needs-attention record, and an admin-triggered sync sweep.
    | "qbo_sync_requeued"
    | "qbo_sweep_triggered";
  targetUid?: string;
  targetEmail?: string;
  oldRole?: AdminRole | null;
  newRole?: AdminRole | null;
  oldStatus?: AdminStatus | null;
  newStatus?: AdminStatus | null;
  // Capability-set transitions for update_admin entries (issue #210) — the
  // stored permission arrays before/after the change.
  oldPermissions?: AdminPermission[];
  newPermissions?: AdminPermission[];
  actingUid: string;
  actingEmail?: string;
  metadata?: Record<string, unknown>;
  timestamp: Timestamp;
}
