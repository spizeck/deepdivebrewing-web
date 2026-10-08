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

// Bounded scans — the collection is append-only and small (one doc per
// settled DDB payment), but never trust unbounded reads on an admin
// surface. `truncated` in the view tells the admin when the cap hit.
const SYNC_VIEW_SCAN_LIMIT = 2000;
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
  const [connSnap, recordsSnap] = await Promise.all([
    qboConnectionRef(environment).get(),
    db
      .collection(QBO_SYNC_RECORDS_COLLECTION)
      .limit(SYNC_VIEW_SCAN_LIMIT)
      .get(),
  ]);

  const conn = usableQboConnection(connSnap.data(), environment);
  const paused =
    !conn || conn.status !== "connected" || !conn.refreshTokenEnc;

  const counts = Object.fromEntries(
    QBO_SYNC_STATUSES.map((status) => [status, 0])
  ) as QboSyncStatusCounts;
  const problems: { view: QboSyncRecordView; sortMs: number }[] = [];

  for (const doc of recordsSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (data.environment !== environment) continue;
    const status = isQboSyncStatus(data.status) ? data.status : "pending";
    counts[status] += 1;
    if (status !== "failed" && status !== "needs_attention") continue;
    const view = toSyncRecordView(doc.id, data);
    problems.push({
      view,
      sortMs:
        Date.parse(view.lastAttemptAt ?? "") ||
        Date.parse(view.updatedAt ?? "") ||
        0,
    });
  }

  problems.sort((a, b) => b.sortMs - a.sortMs);

  return {
    configured: true,
    environment,
    paused,
    counts,
    records: problems.slice(0, PROBLEM_RECORD_LIMIT).map((p) => p.view),
    truncated: recordsSnap.size >= SYNC_VIEW_SCAN_LIMIT,
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
