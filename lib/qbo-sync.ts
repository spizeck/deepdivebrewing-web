import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { getQboEnvironment } from "@/lib/qbo-config";
import { logInfo } from "@/lib/log";
import {
  normalizeQboSyncCandidate,
  persistableQboSyncCandidate,
  qboSyncIdFor,
  QBO_SYNC_RECORDS_COLLECTION,
  type QuickBooksSyncCandidate,
} from "@/lib/qbo-common";

// Forward accounting-export contract (issue #161). This is the seam a
// future producer — the Stripe payments module once #156 merges — calls to
// hand a financial event to the QuickBooks integration. The producer
// supplies safe domain facts; the QBO side owns every bookkeeping decision.
//
// Idempotency design: the sync record's document id is the deterministic
// internal source identity (`environment:sourceType:sourceId`). A durable
// record exists BEFORE any QBO write is considered, so retries, webhook
// replays, job retries, or browser refreshes can never create two QBO
// transactions for the same source event — and a later switch from a
// sandbox to a production connection gets its own record rather than
// colliding with the sandbox one. QBO entity ids stored later are
// correlation references only — they are never the dedupe mechanism.
//
// No bookkeeping is performed here: enqueuing creates a `pending` record
// and nothing more. The worker that maps candidates onto Sales Receipts,
// Invoices, or summarized journals is deliberately deferred — see
// docs/operations/quickbooks.md.

export type QboEnqueueResult =
  | { syncId: string; outcome: "pending" }
  | { syncId: string; outcome: "duplicate" };

// Enqueues a financial event for future QBO export. Idempotent: replaying
// the same source identity returns `duplicate` and leaves the existing
// record (including its current status) untouched.
export async function enqueueAccountingTransaction(
  candidate: QuickBooksSyncCandidate
): Promise<QboEnqueueResult> {
  const normalized = normalizeQboSyncCandidate(candidate);
  const environment = getQboEnvironment();
  const syncId = qboSyncIdFor(
    environment,
    normalized.sourceType,
    normalized.sourceId
  );
  const ref = getFirebaseAdminDb()
    .collection(QBO_SYNC_RECORDS_COLLECTION)
    .doc(syncId);

  const outcome = await getFirebaseAdminDb().runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return "duplicate" as const;
    tx.create(ref, {
      syncId,
      sourceType: normalized.sourceType,
      sourceId: normalized.sourceId,
      status: "pending",
      environment,
      realmId: null,
      qboEntityType: null,
      qboEntityId: null,
      attempts: 0,
      lastAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      idempotencyKey: syncId,
      candidate: persistableQboSyncCandidate(normalized),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return "pending" as const;
  });

  if (outcome === "pending") {
    logInfo("qbo.sync.enqueued", { environment, sourceType: normalized.sourceType });
  }
  return { syncId, outcome };
}
