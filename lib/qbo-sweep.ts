import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { getQboEnvironment } from "@/lib/qbo-config";
import { logError, logInfo, logWarn } from "@/lib/log";
import {
  normalizePaymentStatus,
  timestampMillis,
  PAYMENTS_COLLECTION,
} from "@/lib/payments-common";
import {
  enqueueAccountingTransaction,
  processQboSyncRecord,
  qboStripePaymentCandidate,
  type QboSyncProcessResult,
} from "@/lib/qbo-sync";
import { qboConnectionRef, usableQboConnection } from "@/lib/qbo-tokens";
import {
  QBO_SWEEP_STATE_COLLECTION,
  QBO_SYNC_RECORDS_COLLECTION,
  type QboEnvironment,
} from "@/lib/qbo-common";

// QBO sync sweeper (issue #183) — the scheduled recovery mechanism behind
// the cron route. One invocation performs three bounded, idempotent
// phases:
//
//   1. Missed-enqueue sweep — canonical payments that reached a
//      qualifying terminal state (`paid`/`refunded`) inside the lookback
//      window but have no sync record get one. This is positive-identity
//      only: the `payments` collection contains exclusively DDB-issued
//      records, so Ollie/Spreedly or any other foreign Stripe activity
//      can never be enqueued. The lookback window bounds how far back
//      recovery reaches — anything older stays manual.
//   2. Connection gate — when the connection cannot write (disconnected,
//      reauthorization_required), processing is skipped entirely so
//      records wait untouched instead of burning attempts. Enqueue still
//      runs: durable intent costs nothing and survives the outage.
//   3. Due-record processing — `pending`/`failed` records whose
//      `nextAttemptAt` has passed (plus stale `syncing` leases) are
//      claimed and processed one at a time, up to a per-invocation cap.
//      The claim transaction makes overlapping invocations safe: a second
//      sweeper sees `syncing` and moves on.
//
// Payments/settlement state is never modified here — this module only
// reads `payments` and writes `qboSyncRecords`.

// How far back the missed-enqueue scan reaches. Deliberately short: the
// in-commit create makes misses rare, and anything older is a deliberate
// backfill decision, not a sweeps' business. Configurable via
// QBO_SWEEP_LOOKBACK_HOURS (hours), clamped to [1, 720].
const DEFAULT_LOOKBACK_MS = 72 * 60 * 60 * 1000;
const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

// Per-invocation bounds — every processed record performs Stripe + QBO
// provider calls, so the cap keeps the run inside the function's time
// budget. Anything left over is picked up by the next run.
export const QBO_SWEEP_MAX_RECORDS = 10;
const QBO_SWEEP_PAYMENT_SCAN_LIMIT = 100;
const QBO_SWEEP_RECORD_SCAN_LIMIT = 500;

export function qboSweepLookbackMs(
  raw: string | undefined = process.env.QBO_SWEEP_LOOKBACK_HOURS
): number {
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_LOOKBACK_MS;
  return Math.min(hours * 60 * 60 * 1000, MAX_LOOKBACK_MS);
}

export interface QboSweepSummary {
  environment: QboEnvironment;
  /** True when processing was skipped because the connection cannot
   *  write — records are preserved, nothing was attempted. */
  paused: boolean;
  /** Canonical payments inspected by the missed-enqueue sweep. */
  paymentsScanned: number;
  /** Sync records newly created by the missed-enqueue sweep. */
  enqueued: number;
  /** Payments whose enqueue attempt threw (counted, logged, not fatal). */
  enqueueErrors: number;
  /** Sync records the worker was invoked on this run. */
  processed: number;
  /** Per-record worker outcomes (outcome name → count). */
  outcomes: Partial<Record<QboSyncProcessResult["outcome"], number>>;
  /** Records that threw instead of returning an outcome. */
  errors: number;
}

function emptySummary(environment: QboEnvironment): QboSweepSummary {
  return {
    environment,
    paused: false,
    paymentsScanned: 0,
    enqueued: 0,
    enqueueErrors: 0,
    processed: 0,
    outcomes: {},
    errors: 0,
  };
}

// Phase 1 — missed-enqueue recovery. Enqueue is idempotent on the
// deterministic sync id, so replaying the same payment is a cheap
// `duplicate`, never a second record or a second QBO write.
async function sweepMissedEnqueues(
  environment: QboEnvironment,
  nowMs: number,
  summary: QboSweepSummary
): Promise<void> {
  const cutoff = Timestamp.fromMillis(nowMs - qboSweepLookbackMs());
  const snap = await getFirebaseAdminDb()
    .collection(PAYMENTS_COLLECTION)
    .where("paidAt", ">=", cutoff)
    .orderBy("paidAt")
    .limit(QBO_SWEEP_PAYMENT_SCAN_LIMIT)
    .get();

  for (const doc of snap.docs) {
    const payment = doc.data();
    summary.paymentsScanned += 1;
    const status = normalizePaymentStatus(payment.status);
    if (status !== "paid" && status !== "refunded") continue;
    try {
      const { outcome } = await enqueueAccountingTransaction(
        qboStripePaymentCandidate(payment, doc.id)
      );
      if (outcome === "pending") summary.enqueued += 1;
    } catch {
      summary.enqueueErrors += 1;
      logWarn("qbo.sweep.enqueue_failed", {
        environment,
        paymentId: doc.id,
      });
    }
  }
}

function recordIsDue(
  data: Record<string, unknown>,
  nowMs: number
): boolean {
  const status = data.status;
  if (status === "syncing") {
    // Reclaimable once the claim lease has lapsed — or was never
    // written, which only a crashed claimant explains.
    const leaseMs = timestampMillis(data.syncingLeaseUntil);
    return leaseMs === null || leaseMs <= nowMs;
  }
  if (status === "pending" || status === "failed") {
    const nextAttemptMs = timestampMillis(data.nextAttemptAt);
    return nextAttemptMs === null || nextAttemptMs <= nowMs;
  }
  return false;
}

// Phase 3 — drain due sync records. Candidates come from ONE bounded
// page of the `status in (...)` scan ordered by `syncId` (which mirrors
// the document id), resuming after the persisted per-environment cursor
// in `qboSweepState`. Rotation matters: without it, a full page of
// not-due records would be returned on every run and could starve a due
// record behind the scan cap indefinitely. Due-ness, environment, and
// oldest-first ordering are still applied in code on the page.
async function processDueRecords(
  environment: QboEnvironment,
  nowMs: number,
  summary: QboSweepSummary
): Promise<void> {
  const db = getFirebaseAdminDb();
  const cursorRef = db.collection(QBO_SWEEP_STATE_COLLECTION).doc(environment);
  const cursorData = (await cursorRef.get()).data() as
    | { lastSyncId?: unknown }
    | undefined;
  const afterId =
    typeof cursorData?.lastSyncId === "string" ? cursorData.lastSyncId : null;

  const page = db
    .collection(QBO_SYNC_RECORDS_COLLECTION)
    .where("status", "in", ["pending", "failed", "syncing"])
    .orderBy("syncId");
  const snap = await (afterId ? page.startAfter(afterId) : page)
    .limit(QBO_SWEEP_RECORD_SCAN_LIMIT)
    .get();

  const due = snap.docs
    .filter((doc) => {
      const data = doc.data() as Record<string, unknown>;
      if (data.environment !== environment) return false;
      return recordIsDue(data, nowMs);
    })
    .sort((a, b) => {
      const at =
        timestampMillis(a.data().lastAttemptAt) ??
        timestampMillis(a.data().createdAt) ??
        0;
      const bt =
        timestampMillis(b.data().lastAttemptAt) ??
        timestampMillis(b.data().createdAt) ??
        0;
      return at - bt;
    })
    .slice(0, QBO_SWEEP_MAX_RECORDS);

  for (const doc of due) {
    summary.processed += 1;
    try {
      const result = await processQboSyncRecord(doc.id);
      summary.outcomes[result.outcome] =
        (summary.outcomes[result.outcome] ?? 0) + 1;
    } catch (error) {
      summary.errors += 1;
      logError("qbo.sweep.record_failed", error, { environment });
    }
  }

  // Advance the cursor past this page; a short page means the filtered
  // set was exhausted, so reset to the beginning. Compare-and-set keeps
  // an overlapping invocation that already moved the cursor from being
  // rewound by this run's stale read.
  const reachedEnd = snap.size < QBO_SWEEP_RECORD_SCAN_LIMIT;
  const nextId = reachedEnd
    ? null
    : (snap.docs[snap.docs.length - 1]?.id ?? null);
  await db.runTransaction(async (tx) => {
    const current = (await tx.get(cursorRef)).data() as
      | { lastSyncId?: unknown }
      | undefined;
    const currentId =
      typeof current?.lastSyncId === "string" ? current.lastSyncId : null;
    if (currentId !== afterId) return;
    tx.set(cursorRef, { lastSyncId: nextId, updatedAt: Timestamp.now() });
  });
}

// Runs one full sweep. Called by the cron route (CRON_SECRET) and by the
// admin "run sweep" action; both share this single implementation so the
// behavior — and its bounds — can never diverge.
export async function runQboSyncSweep(
  nowMs: number = Date.now()
): Promise<QboSweepSummary> {
  const environment = getQboEnvironment();
  const summary = emptySummary(environment);

  await sweepMissedEnqueues(environment, nowMs, summary).catch((error) => {
    // A scan failure must not take the whole sweep down — record
    // processing still runs.
    logError("qbo.sweep.enqueue_scan_failed", error, { environment });
    summary.enqueueErrors += 1;
  });

  const connSnap = await qboConnectionRef(environment).get();
  const conn = usableQboConnection(connSnap.data(), environment);
  if (!conn || conn.status !== "connected" || !conn.refreshTokenEnc) {
    summary.paused = true;
    logInfo("qbo.sweep.paused", {
      environment,
      paymentsScanned: summary.paymentsScanned,
      enqueued: summary.enqueued,
    });
    return summary;
  }

  await processDueRecords(environment, nowMs, summary);

  logInfo("qbo.sweep.completed", {
    environment,
    paymentsScanned: summary.paymentsScanned,
    enqueued: summary.enqueued,
    enqueueErrors: summary.enqueueErrors,
    processed: summary.processed,
    synced: summary.outcomes.synced ?? 0,
    failed: summary.outcomes.failed ?? 0,
    needsAttention: summary.outcomes.needs_attention ?? 0,
    deferred: summary.outcomes.deferred ?? 0,
    pausedRecords: summary.outcomes.paused ?? 0,
    errors: summary.errors,
  });
  return summary;
}

// Reconnect follow-up (issue #183): records that failed with
// `authorization_expired` are pulled forward to "due now" so the next
// sweep picks them up immediately rather than waiting out a backoff that
// assumed a still-broken grant. Pending records need no help — they were
// never attempted and are already due. Best-effort: called from the OAuth
// callback, which must not fail on bookkeeping cleanup.
export async function resumeQboSyncAfterReconnect(
  environment: QboEnvironment
): Promise<number> {
  const db = getFirebaseAdminDb();
  const snap = await db
    .collection(QBO_SYNC_RECORDS_COLLECTION)
    .where("status", "==", "failed")
    .limit(QBO_SWEEP_RECORD_SCAN_LIMIT)
    .get();
  const eligible = snap.docs.filter((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return (
      data.environment === environment &&
      data.lastErrorCode === "authorization_expired"
    );
  });
  if (!eligible.length) return 0;

  const now = Timestamp.now();
  const batch = db.batch();
  for (const doc of eligible) {
    batch.update(doc.ref, { nextAttemptAt: now, updatedAt: now });
  }
  await batch.commit();
  logInfo("qbo.sync.resumed", { environment, count: eligible.length });
  return eligible.length;
}
