import "server-only";
import { getFirebaseAdminDb } from "@/lib/firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import type { AdminRole, AdminStatus } from "@/lib/types";

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
  timestamp: FirebaseFirestore.Timestamp;
}

const COLLECTION = "adminAuditLogs";

export async function logAdminAudit(
  record: Omit<AdminAuditRecord, "timestamp">
): Promise<void> {
  await getFirebaseAdminDb()
    .collection(COLLECTION)
    .add({
      ...record,
      timestamp: Timestamp.now(),
    });
}
