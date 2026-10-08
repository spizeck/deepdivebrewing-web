import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { logAdminAudit } from "@/lib/admin-audit";
import type { AdminActor } from "@/lib/admin-auth";
import { toIsoString } from "@/lib/admin-serializers";
import { getQboEnvironment } from "@/lib/qbo-config";
import { QboError } from "@/lib/qbo-errors";
import { logWarn } from "@/lib/log";
import { qboConnectionRef, usableQboConnection } from "@/lib/qbo-tokens";
import {
  processQboSyncRecord,
  type QboSyncProcessResult,
} from "@/lib/qbo-sync";
import {
  abbreviateRealmId,
  isQboSyncStatus,
  QBO_SYNC_RECORDS_COLLECTION,
  QBO_SYNC_STATUSES,
  type QboSyncAdminView,
  type QboSyncRecordView,
  type QboSyncStatusCounts,
} from "@/lib/qbo-common";

// Admin-facing sync operations (issue #183): a compact status view for
// the QuickBooks admin page plus the manual requeue action. Everything
// serialized here is operational metadata — never the stored candidate
// payload (customer PII), tokens, or raw provider responses.

// Bounded reads — counts come from per-status count() aggregations
// (equality filters only, no composite index) so they stay correct as
// the collection grows. Problem records are queried directly by
// environment + status and ordered by `updatedAt` desc server-side
// (composite index in firestore.indexes.json), so the newest problems
// for this environment always win the scan cap — a safety valve for a
// pathological failure backlog that `truncated` makes visible.
const PROBLEM_SCAN_LIMIT = 500;
const PROBLEM_RECORD_LIMIT = 15;
const REQUEUE_ELIGIBLE = new Set(["failed", "needs_attention"]);

function toSyncRecordView(
  syncId: string,
  data: Record<string, unknown>
): QboSyncRecordView {
  const realmId =
    typeof data.realmId === "string" && data.realmId
      ? abbreviateRealmId(data.realmId)
      : undefined;
  const str = (key: string): string | undefined =>
    typeof data[key] === "string" && data[key] ? (data[key] as string) : undefined;
  return {
    syncId,
    sourceType: str("sourceType") ?? "unknown",
    sourceId: str("sourceId") ?? "",
    status: isQboSyncStatus(data.status) ? data.status : "pending",
    attempts: typeof data.attempts === "number" ? data.attempts : 0,
    lastAttemptAt: toIsoString(data.lastAttemptAt),
    nextAttemptAt: toIsoString(data.nextAttemptAt),
    lastErrorCode: str("lastErrorCode"),
    lastErrorMessage: str("lastErrorMessage"),
    qboEntityType: str("qboEntityType"),
    qboEntityId: str("qboEntityId"),
    realmIdShort: realmId,
    updatedAt: toIsoString(data.updatedAt),
  };
}

// Status counts + the recent problem records the admin panel shows.
// Paused state comes from the connection record — the same condition the
// worker checks before claiming.
export async function getQboSyncAdminView(): Promise<QboSyncAdminView> {
  const environment = getQboEnvironment();
  const db = getFirebaseAdminDb();
  const collection = db.collection(QBO_SYNC_RECORDS_COLLECTION);

  const counts = Object.fromEntries(
    QBO_SYNC_STATUSES.map((status) => [status, 0])
  ) as QboSyncStatusCounts;
  const [connSnap, problemsSnap] = await Promise.all([
    qboConnectionRef(environment).get(),
    collection
      .where("environment", "==", environment)
      .where("status", "in", ["failed", "needs_attention"])
      .orderBy("updatedAt", "desc")
      .limit(PROBLEM_SCAN_LIMIT)
      .get(),
    ...QBO_SYNC_STATUSES.map(async (status) => {
      const aggregate = await collection
        .where("environment", "==", environment)
        .where("status", "==", status)
        .count()
        .get();
      counts[status] = aggregate.data().count;
    }),
  ]);

  const conn = usableQboConnection(connSnap.data(), environment);
  const paused =
    !conn || conn.status !== "connected" || !conn.refreshTokenEnc;

  // Already env-filtered and newest-activity-first from the query.
  const problems = problemsSnap.docs.map((doc) =>
    toSyncRecordView(doc.id, doc.data() as Record<string, unknown>)
  );

  return {
    configured: true,
    environment,
    paused,
    counts,
    records: problems.slice(0, PROBLEM_RECORD_LIMIT),
    truncated: problemsSnap.size >= PROBLEM_SCAN_LIMIT,
  };
}

export interface QboSyncRequeueResult {
  syncId: string;
  outcome: QboSyncProcessResult["outcome"];
  qboEntityId?: string | null;
  reason?: string;
}

// Manual retry (issue #183): a human has corrected the underlying cause
// (mapping fixed, reconnect done, record verified), so the record goes
// back to `pending` with a fresh attempt budget and is processed inline
// for immediate feedback. Every safety gate still applies — the worker
// re-verifies canonical Stripe state, mapping, environment/realm, and
// idempotency; requeue only resets scheduling.
export async function requeueQboSyncRecord(
  actor: AdminActor,
  syncId: string
): Promise<QboSyncRequeueResult> {
  const environment = getQboEnvironment();
  const cleanId = typeof syncId === "string" ? syncId.trim() : "";
  if (!cleanId || cleanId.length > 200) {
    throw new QboError("A valid sync id is required.", "validation", 400);
  }
  const ref = getFirebaseAdminDb()
    .collection(QBO_SYNC_RECORDS_COLLECTION)
    .doc(cleanId);

  const priorError = await getFirebaseAdminDb().runTransaction(
    async (tx) => {
      const snap = await tx.get(ref);
      const record = snap.data() as Record<string, unknown> | undefined;
      if (!snap.exists || !record) {
        throw new QboError(
          "QuickBooks sync record not found.",
          "validation",
          404
        );
      }
      if (record.environment !== environment) {
        throw new QboError(
          "That sync record belongs to a different QuickBooks environment.",
          "validation",
          409
        );
      }
      const status = typeof record.status === "string" ? record.status : "";
      if (!REQUEUE_ELIGIBLE.has(status)) {
        throw new QboError(
          status === "syncing"
            ? "That sync record is currently being processed."
            : `Only failed or needs-attention records can be requeued (current: ${status || "unknown"}).`,
          "validation",
          409
        );
      }
      tx.update(ref, {
        status: "pending",
        attempts: 0,
        nextAttemptAt: null,
        syncingLeaseUntil: FieldValue.delete(),
        requeuedAt: Timestamp.now(),
        requeuedByUid: actor.token.uid,
        updatedAt: Timestamp.now(),
      });
      return typeof record.lastErrorCode === "string"
        ? record.lastErrorCode
        : null;
    }
  );

  try {
    await logAdminAudit({
      action: "qbo_sync_requeued",
      actingUid: actor.token.uid,
      actingEmail: actor.token.email ?? actor.record.email,
      metadata: { environment, syncId: cleanId, priorError },
    });
  } catch {
    logWarn("qbo.audit_failed", { action: "qbo_sync_requeued" });
  }

  const result = await processQboSyncRecord(cleanId);
  return {
    syncId: cleanId,
    outcome: result.outcome,
    qboEntityId:
      result.outcome === "synced" || result.outcome === "already_synced"
        ? result.qboEntityId
        : undefined,
    reason:
      result.outcome === "failed" || result.outcome === "needs_attention"
        ? result.reason
        : undefined,
  };
}
