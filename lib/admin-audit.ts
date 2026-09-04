import "server-only";
import { getFirebaseAdminDb } from "@/lib/firebase-admin";
import { dropUndefinedValues } from "@/lib/admin-audit-common";
import type { AdminAuditRecord } from "@/lib/admin-types";
import { Timestamp } from "firebase-admin/firestore";

const COLLECTION = "adminAuditLogs";

export async function logAdminAudit(
  record: Omit<AdminAuditRecord, "timestamp">
): Promise<void> {
  const sanitized = dropUndefinedValues(record) as Omit<AdminAuditRecord, "timestamp">;
  await getFirebaseAdminDb()
    .collection(COLLECTION)
    .add({
      ...sanitized,
      timestamp: Timestamp.now(),
    });
}
