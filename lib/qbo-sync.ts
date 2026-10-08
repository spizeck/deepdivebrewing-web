import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { getQboEnvironment } from "@/lib/qbo-config";
import { logError, logInfo, logWarn } from "@/lib/log";
import { getStripeClient } from "@/lib/stripe";
import {
  normalizePaymentStatus,
  paymentIdFromSession,
  timestampMillis,
  toPaymentProviderError,
  PAYMENTS_COLLECTION,
} from "@/lib/payments-common";
import {
  getQuickBooksAccessToken,
  qboConnectionRef,
  usableQboConnection,
} from "@/lib/qbo-tokens";
import { getQboMappingView } from "@/lib/qbo-mapping";
import {
  createQboSalesReceipt,
  findQboSalesReceiptForMarker,
} from "@/lib/qbo-api";
import { buildQboSalesReceiptPayload } from "@/lib/qbo-protocol";
import { QboError } from "@/lib/qbo-errors";
import {
  normalizeQboSyncCandidate,
  persistableQboSyncCandidate,
  qboIncomeItemKeyForPurpose,
  qboSalesReceiptMarker,
  qboSyncIdFor,
  QBO_CONNECTIONS_COLLECTION,
  QBO_SALES_RECEIPT_ENTITY_TYPE,
  QBO_STRIPE_PAYMENT_SOURCE_TYPE,
  QBO_SYNC_RECORDS_COLLECTION,
  type QboEnvironment,
  type QuickBooksSyncCandidate,
} from "@/lib/qbo-common";

// Accounting export for settled DDB-admin payments (issues #161/#179).
// The payments module calls postPaidPaymentToQbo after a canonical `paid`
// commit; this module owns every bookkeeping decision.
//
// Source identity is positive and structural: the only qualifying source
// is a record in the app's own `payments` collection whose canonical
// Stripe session points back at the same internal id. Ollie/Spreedly
// charges and any other foreign Stripe activity never reach this path —
// they have no payments/ document and no sync record is ever enqueued.
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
// Worker claim model: one `syncing` claimant at a time via a Firestore
// transaction with a short lease; a stale lease is reclaimable. Because
// QBO offers no create-time idempotency key, the worker queries for the
// correlation marker before every create — a write that landed but whose
// response was lost is adopted, never duplicated.

export type QboEnqueueResult =
  | { syncId: string; outcome: "pending" }
  | { syncId: string; outcome: "duplicate" };

// The durable record body for a fresh sync record — shared between the
// standalone enqueue path and the atomic in-commit create the payments
// seam performs inside the `paid` transition transaction.
export function buildQboSyncRecordDoc(
  environment: QboEnvironment,
  normalized: QuickBooksSyncCandidate
): Record<string, unknown> {
  const syncId = qboSyncIdFor(
    environment,
    normalized.sourceType,
    normalized.sourceId
  );
  return {
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
    nextAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    idempotencyKey: syncId,
    candidate: persistableQboSyncCandidate(normalized),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

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
    tx.create(ref, buildQboSyncRecordDoc(environment, normalized));
    return "pending" as const;
  });

  if (outcome === "pending") {
    logInfo("qbo.sync.enqueued", { environment, sourceType: normalized.sourceType });
  }
  return { syncId, outcome };
}

// --- Sync worker (#179) ---

// How long one claimant may work a record before a retry may reclaim it.
// Long enough for token refresh + two QBO calls; short enough that a
// crashed worker does not strand the record.
const SYNC_CLAIM_LEASE_MS = 2 * 60 * 1000;

// Minimum claim lease remaining before a Sales Receipt create may start.
// QBO offers no create-time idempotency key, so a create must never be
// in flight when the lease could lapse — a successor reclaiming the
// record would not know the POST was still running and could create a
// second receipt. With every provider call bounded by
// QBO_REQUEST_TIMEOUT_MS, a create started with this margin always
// resolves before the lease expires; a landed-but-aborted write is then
// adopted by the next attempt's marker lookup instead of duplicated.
const SYNC_CREATE_MIN_LEASE_MS = 30_000;

// Bounded retry policy (#183). A transient failure schedules
// `nextAttemptAt` = now + delay for the attempt number that just ran
// (1-based): attempt 1 waits 1 minute, attempt 6 waits 8 hours, and a
// record that still fails on attempt QBO_SYNC_MAX_ATTEMPTS parks in
// `needs_attention` for a human instead of retrying forever. The sweep
// only claims records whose `nextAttemptAt` has passed.
export const QBO_SYNC_RETRY_DELAYS_MS = [
  60 * 1000,
  5 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  4 * 60 * 60 * 1000,
  8 * 60 * 60 * 1000,
] as const;

export const QBO_SYNC_MAX_ATTEMPTS = 8;

export function qboSyncRetryDelayMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), QBO_SYNC_RETRY_DELAYS_MS.length);
  return QBO_SYNC_RETRY_DELAYS_MS[index - 1];
}

interface QboSyncRecordDoc {
  sourceType?: string;
  sourceId?: string;
  status?: string;
  qboEntityId?: string | null;
  realmId?: string | null;
  attempts?: number;
  syncingLeaseUntil?: Timestamp;
  nextAttemptAt?: Timestamp | null;
  lastErrorCode?: string | null;
}

export type QboSyncProcessResult =
  | { outcome: "synced"; qboEntityId: string; adopted: boolean }
  | { outcome: "already_synced"; qboEntityId?: string | null }
  | { outcome: "in_progress" }
  | { outcome: "needs_attention"; reason: string }
  | { outcome: "failed"; reason: string }
  // The connection cannot write right now (disconnected /
  // reauthorization_required) — the record is untouched and preserved.
  | { outcome: "paused" }
  // A retry is already scheduled for later — not due yet.
  | { outcome: "deferred" }
  | { outcome: "missing" };

type SyncWriteResult =
  | {
      kind: "synced";
      qboEntityId: string;
      realmId: string;
      adopted: boolean;
      correlationId?: string;
    }
  | { kind: "failed"; code: string; message: string; correlationId?: string }
  | {
      kind: "needs_attention";
      code: string;
      message: string;
      correlationId?: string;
    };

function attention(
  code: string,
  message: string,
  correlationId?: string
): SyncWriteResult {
  return { kind: "needs_attention", code, message, correlationId };
}

function failure(
  code: string,
  message: string,
  correlationId?: string
): SyncWriteResult {
  return { kind: "failed", code, message, correlationId };
}

// QBO failure → record state. Validation/permission/configuration means
// retrying unchanged cannot help — a human fixes config first
// (needs_attention). Everything else is retryable (failed).
function classifyQboSyncError(error: unknown): SyncWriteResult {
  if (error instanceof QboError) {
    const nonRetryable =
      error.kind === "validation" ||
      error.kind === "permission_denied" ||
      error.kind === "configuration";
    return nonRetryable
      ? attention(error.kind, error.message, error.correlationId)
      : failure(error.kind, error.message, error.correlationId);
  }
  return failure("unexpected", "QuickBooks sync failed unexpectedly — retry later.");
}

function syncRef(syncId: string) {
  return getFirebaseAdminDb()
    .collection(QBO_SYNC_RECORDS_COLLECTION)
    .doc(syncId);
}

// Commits the outcome for a claimed record — but only while the claim is
// still ours. If the lease lapsed mid-flight and a successor reclaimed
// the record, this worker's verdict must not clobber its state.
//
// `attempts` is the count including the attempt that just ran. A
// retryable failure schedules `nextAttemptAt` from the backoff table;
// once the budget is spent the record parks in `needs_attention` with a
// `retry_exhausted` code — a human fixes the cause and requeues it.
async function finalizeSyncClaim(
  syncId: string,
  leaseUntilMs: number,
  attempts: number,
  result: SyncWriteResult
): Promise<void> {
  const ref = syncRef(syncId);
  await getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const record = snap.data() as QboSyncRecordDoc | undefined;
    if (
      !record ||
      record.status !== "syncing" ||
      record.syncingLeaseUntil?.toMillis() !== leaseUntilMs
    ) {
      return;
    }
    const done: Record<string, unknown> = {
      syncingLeaseUntil: FieldValue.delete(),
      updatedAt: Timestamp.now(),
      lastQboCorrelationId: result.correlationId ?? null,
    };
    if (result.kind === "synced") {
      tx.update(ref, {
        ...done,
        status: "synced",
        qboEntityType: QBO_SALES_RECEIPT_ENTITY_TYPE,
        qboEntityId: result.qboEntityId,
        realmId: result.realmId,
        nextAttemptAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      });
    } else if (result.kind === "failed" && attempts >= QBO_SYNC_MAX_ATTEMPTS) {
      tx.update(ref, {
        ...done,
        status: "needs_attention",
        nextAttemptAt: null,
        lastErrorCode: "retry_exhausted",
        lastErrorMessage: `Retry limit reached after ${attempts} attempts (last error: ${result.code}).`,
      });
    } else {
      tx.update(ref, {
        ...done,
        status: result.kind,
        nextAttemptAt:
          result.kind === "failed"
            ? Timestamp.fromMillis(Date.now() + qboSyncRetryDelayMs(attempts))
            : null,
        lastErrorCode: result.code,
        lastErrorMessage: result.message,
      });
    }
  });
}

// The bookkeeping work for one claimed stripe_payment record: verify the
// payment is genuinely settled (own record + canonical Stripe session),
// gate on mapping, then find-or-create exactly one Sales Receipt.
async function runSyncWrite(
  sourceType: string | undefined,
  sourceId: string | undefined,
  environment: QboEnvironment,
  leaseUntilMs: number
): Promise<SyncWriteResult> {
  if (sourceType !== QBO_STRIPE_PAYMENT_SOURCE_TYPE || !sourceId) {
    return attention(
      "unsupported_source",
      "This sync record type is not supported by the QBO writer."
    );
  }
  const db = getFirebaseAdminDb();

  // --- Positive DDB identity + settlement (canonical record) ---
  const paymentSnap = await db.collection(PAYMENTS_COLLECTION).doc(sourceId).get();
  const payment = paymentSnap.data();
  if (!payment) {
    return attention(
      "payment_missing",
      "The DDB payment record for this sync no longer exists."
    );
  }
  const status = normalizePaymentStatus(payment.status);
  // `refunded` still requires the original Sales Receipt — the reversal
  // is a separate RefundReceipt concern (#180).
  const settled = (status === "paid" || status === "refunded") && !payment.reconciliationIssue;
  const paidAtMs = timestampMillis(payment.paidAt);
  const sessionId =
    typeof payment.stripeCheckoutSessionId === "string" &&
    payment.stripeCheckoutSessionId
      ? payment.stripeCheckoutSessionId
      : null;
  const amountMinor =
    typeof payment.amountMinor === "number" && payment.amountMinor > 0
      ? payment.amountMinor
      : null;
  const currency =
    typeof payment.currency === "string" && payment.currency
      ? payment.currency.toUpperCase()
      : "USD";
  if (!settled || !paidAtMs || !sessionId || !amountMinor) {
    return attention(
      "payment_not_settled",
      "The payment record does not show a verified settled charge."
    );
  }

  // --- Mapping gate — fail closed before any provider write ---
  const mappingView = await getQboMappingView();
  if (!mappingView.configured || !mappingView.mapping) {
    return attention(
      "mapping_unconfigured",
      "QuickBooks accounting mapping is not configured for the connected company."
    );
  }
  // A stored document missing any required field is an unfinished
  // configuration — posting must not run at all until it is complete,
  // even when this payment's own fields happen to be set.
  if ((mappingView.missingFields ?? []).length > 0) {
    return attention(
      "mapping_incomplete",
      "The QuickBooks accounting mapping is incomplete — required fields are missing."
    );
  }
  const mapping = mappingView.mapping;
  const itemKey = qboIncomeItemKeyForPurpose(
    typeof payment.purpose === "string" ? payment.purpose : undefined
  );
  // An unrecognized purpose must never fall through to a generic item —
  // it fails closed for a human to decide where it belongs.
  if (!itemKey) {
    return attention(
      "purpose_unmapped",
      "The payment's purpose has no QuickBooks income item mapping."
    );
  }
  const incomeItemId = mapping[itemKey];
  if (!incomeItemId) {
    // Defensive: unreachable while the completeness gate above is
    // consistent with the mapping — guards the invariant directly.
    return attention(
      "missing_incomeItem",
      "The income item required for this payment's purpose is not mapped."
    );
  }
  if (!mapping.stripeClearingAccountId) {
    return attention(
      "missing_stripeClearingAccountId",
      "No Stripe clearing account is mapped for QuickBooks posting."
    );
  }
  if (!mapping.fallbackCustomerId) {
    return attention(
      "missing_fallbackCustomerId",
      "No generic sales customer is mapped for QuickBooks posting."
    );
  }

  // --- Canonical Stripe verification (provider boundary, never the
  // stored record alone) ---
  let session: Record<string, unknown>;
  try {
    session = (await getStripeClient().checkout.sessions.retrieve(
      sessionId
    )) as unknown as Record<string, unknown>;
  } catch (error) {
    return failure(
      toPaymentProviderError(error).code,
      "Stripe settlement could not be re-verified — retry later."
    );
  }
  if (paymentIdFromSession(session) !== sourceId) {
    return attention(
      "identity_mismatch",
      "The Stripe session does not belong to this payment record."
    );
  }
  if (session.status === "open") {
    return failure(
      "stripe_not_settled",
      "Stripe has not finished settling this payment — retry later."
    );
  }
  if (session.status !== "complete" || session.payment_status !== "paid") {
    return attention(
      "stripe_not_settled",
      "Stripe's canonical state does not show this payment as settled."
    );
  }
  if (session.amount_total !== amountMinor) {
    return attention(
      "amount_mismatch",
      "Stripe's settled amount differs from the payment record."
    );
  }
  const sessionCurrency =
    typeof session.currency === "string"
      ? session.currency.toUpperCase()
      : null;
  if (sessionCurrency !== currency) {
    return attention(
      "currency_mismatch",
      "Stripe's settled currency differs from the payment record."
    );
  }
  const sessionPi = session.payment_intent;
  const paymentIntentId =
    (typeof sessionPi === "string"
      ? sessionPi
      : sessionPi &&
          typeof sessionPi === "object" &&
          typeof (sessionPi as { id?: unknown }).id === "string"
        ? (sessionPi as { id: string }).id
        : undefined) ??
    (typeof payment.stripePaymentIntentId === "string"
      ? payment.stripePaymentIntentId
      : undefined);
  const chargeId =
    typeof payment.stripeChargeId === "string" ? payment.stripeChargeId : undefined;

  // --- Provider calls (token + correlation lookup + create) ---
  try {
    const { accessToken, realmId } = await getQuickBooksAccessToken();

    // `GlobalTaxCalculation` is required on sales transactions for non-US
    // companies and rejected for US ones — derive it from the connected
    // company's country, never from assumption.
    const connectionSnap = await db
      .collection(QBO_CONNECTIONS_COLLECTION)
      .doc(environment)
      .get();
    const companyCountry = connectionSnap.data()?.companyCountry;
    const globalTaxCalculation =
      companyCountry === "US" ? undefined : ("NotApplicable" as const);

    // Provider-side recovery: adopt a receipt that already carries this
    // payment's marker rather than posting a duplicate.
    const existing = await findQboSalesReceiptForMarker({
      environment,
      realmId,
      accessToken,
      customerId: mapping.fallbackCustomerId,
      txnDate: new Date(paidAtMs).toISOString().slice(0, 10),
      marker: qboSalesReceiptMarker(sourceId),
    });
    if (existing) {
      return {
        kind: "synced",
        qboEntityId: existing.id,
        realmId,
        adopted: true,
        correlationId: existing.correlationId,
      };
    }

    // The create is the only unrecoverable-side-effect call in the path —
    // refuse to start it unless enough lease remains for the bounded
    // request to resolve before a successor could reclaim the record.
    if (Date.now() > leaseUntilMs - SYNC_CREATE_MIN_LEASE_MS) {
      return failure(
        "lease_expiring",
        "The sync claim nearly expired before the QuickBooks write — retry later."
      );
    }
    const created = await createQboSalesReceipt({
      environment,
      realmId,
      accessToken,
      payload: buildQboSalesReceiptPayload({
        sourceId,
        amountMinor,
        currency,
        paidAtMs,
        description:
          typeof payment.description === "string"
            ? payment.description
            : undefined,
        clearingAccountId: mapping.stripeClearingAccountId,
        incomeItemId,
        customerId: mapping.fallbackCustomerId,
        paymentIntentId,
        chargeId,
        globalTaxCalculation,
      }),
    });
    return {
      kind: "synced",
      qboEntityId: created.id,
      realmId,
      adopted: false,
      correlationId: created.correlationId,
    };
  } catch (error) {
    return classifyQboSyncError(error);
  }
}

// Processes one durable sync record through the Sales-Receipt write path.
// Idempotent end to end: a `synced` record returns its stored entity id,
// a fresh claim performs the gated write, and every outcome is committed
// back to the record so later triggers converge.
export async function processQboSyncRecord(
  syncId: string
): Promise<QboSyncProcessResult> {
  const environment = getQboEnvironment();
  const nowMs = Date.now();
  const leaseUntilMs = nowMs + SYNC_CLAIM_LEASE_MS;
  const claim = await getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(syncRef(syncId));
    const record = snap.data() as QboSyncRecordDoc | undefined;
    if (!snap.exists || !record) return { action: "missing" as const };
    if (record.status === "synced") {
      return {
        action: "already_synced" as const,
        qboEntityId: record.qboEntityId,
      };
    }
    if (record.status === "needs_attention") {
      return {
        action: "needs_attention" as const,
        reason:
          typeof record.lastErrorCode === "string" && record.lastErrorCode
            ? record.lastErrorCode
            : "needs_attention",
      };
    }
    if (
      record.status === "syncing" &&
      record.syncingLeaseUntil &&
      record.syncingLeaseUntil.toMillis() > nowMs
    ) {
      return { action: "in_progress" as const };
    }

    const attempts =
      typeof record.attempts === "number" ? record.attempts : 0;

    // Retry budget spent — park for a human (covers records that reached
    // the limit before the finalize-time exhaustion check existed).
    if (attempts >= QBO_SYNC_MAX_ATTEMPTS) {
      tx.update(syncRef(syncId), {
        status: "needs_attention",
        nextAttemptAt: null,
        syncingLeaseUntil: FieldValue.delete(),
        lastErrorCode: "retry_exhausted",
        lastErrorMessage: `Retry limit reached after ${attempts} attempts${
          record.lastErrorCode ? ` (last error: ${record.lastErrorCode})` : ""
        }. Fix the cause and retry manually.`,
        updatedAt: Timestamp.now(),
      });
      return {
        action: "needs_attention" as const,
        reason: "retry_exhausted",
      };
    }

    // Bounded backoff: a failed/pending record is not eligible until its
    // scheduled retry time. Missing nextAttemptAt = due now (fresh or
    // legacy records). A stale `syncing` lease reclaims immediately —
    // the schedule belongs to the attempt, not the crashed claimant.
    if (record.status !== "syncing") {
      const nextAttemptMs = timestampMillis(record.nextAttemptAt);
      if (nextAttemptMs !== null && nextAttemptMs > nowMs) {
        return { action: "deferred" as const };
      }
    }

    // Pause gate: while the connection cannot write (disconnected or
    // reauthorization_required) records are preserved untouched — no
    // claim, no attempt consumed. Read inside the claim transaction so
    // the decision is consistent with the write that follows.
    const connSnap = await tx.get(qboConnectionRef(environment));
    const conn = usableQboConnection(connSnap.data(), environment);
    if (!conn || conn.status !== "connected" || !conn.refreshTokenEnc) {
      return { action: "paused" as const };
    }

    tx.update(syncRef(syncId), {
      status: "syncing",
      attempts: attempts + 1,
      lastAttemptAt: Timestamp.now(),
      syncingLeaseUntil: Timestamp.fromMillis(leaseUntilMs),
      updatedAt: Timestamp.now(),
    });
    return {
      action: "claimed" as const,
      sourceType: record.sourceType,
      sourceId: record.sourceId,
      attempts: attempts + 1,
    };
  });

  switch (claim.action) {
    case "missing":
      return { outcome: "missing" };
    case "already_synced":
      logInfo("qbo.sync.duplicate", { environment });
      return { outcome: "already_synced", qboEntityId: claim.qboEntityId };
    case "needs_attention":
      return { outcome: "needs_attention", reason: claim.reason };
    case "in_progress":
      return { outcome: "in_progress" };
    case "paused":
      return { outcome: "paused" };
    case "deferred":
      return { outcome: "deferred" };
  }

  const result = await runSyncWrite(
    claim.sourceType,
    claim.sourceId,
    environment,
    leaseUntilMs
  );
  await finalizeSyncClaim(syncId, leaseUntilMs, claim.attempts, result);

  if (result.kind === "synced") {
    logInfo("qbo.sync.posted", {
      environment,
      adopted: result.adopted,
      correlationId: result.correlationId,
    });
    return {
      outcome: "synced",
      qboEntityId: result.qboEntityId,
      adopted: result.adopted,
    };
  }
  if (result.kind === "needs_attention") {
    logWarn("qbo.sync.needs_attention", {
      environment,
      reason: result.code,
      correlationId: result.correlationId,
    });
    return { outcome: "needs_attention", reason: result.code };
  }
  logError("qbo.sync.failed", undefined, {
    environment,
    reason: result.code,
    correlationId: result.correlationId,
  });
  return { outcome: "failed", reason: result.code };
}

// --- Producer seam (#179) ---

// Builds the sync candidate from a settled payment record. Shared by the
// post-commit helper and the atomic in-commit create the payments seam
// performs inside the `paid` transition transaction — pass the merged
// post-update record there so paidAt/externalRefs are already populated.
export function qboStripePaymentCandidate(
  payment: Record<string, unknown>,
  paymentId: string
): QuickBooksSyncCandidate {
  const paidAtMs = timestampMillis(payment.paidAt);
  const externalRefs: Record<string, string> = {};
  if (
    typeof payment.stripeCheckoutSessionId === "string" &&
    payment.stripeCheckoutSessionId
  ) {
    externalRefs.checkoutSessionId = payment.stripeCheckoutSessionId;
  }
  if (
    typeof payment.stripePaymentIntentId === "string" &&
    payment.stripePaymentIntentId
  ) {
    externalRefs.paymentIntentId = payment.stripePaymentIntentId;
  }
  if (typeof payment.stripeChargeId === "string" && payment.stripeChargeId) {
    externalRefs.chargeId = payment.stripeChargeId;
  }
  return {
    sourceType: QBO_STRIPE_PAYMENT_SOURCE_TYPE,
    sourceId: paymentId,
    amountMinorUnits:
      typeof payment.amountMinor === "number" ? payment.amountMinor : 0,
    currency:
      typeof payment.currency === "string" && payment.currency
        ? payment.currency
        : "usd",
    transactionDate: new Date(paidAtMs ?? Date.now()).toISOString(),
    customerName:
      typeof payment.customerName === "string"
        ? payment.customerName
        : undefined,
    customerEmail:
      typeof payment.customerEmail === "string"
        ? payment.customerEmail
        : undefined,
    purpose:
      typeof payment.purpose === "string" ? payment.purpose : undefined,
    description:
      typeof payment.description === "string"
        ? payment.description
        : undefined,
    externalRefs: Object.keys(externalRefs).length ? externalRefs : undefined,
    tourDate:
      typeof payment.tourDate === "string" ? payment.tourDate : undefined,
    attendeeCount:
      typeof payment.attendeeCount === "number"
        ? payment.attendeeCount
        : undefined,
  };
}

// Called after a canonical `paid` commit (webhook or manual refresh).
// The durable sync record is normally created inside the commit
// transaction itself; this helper is the independent ensure + inline
// processing attempt — a record committed without an in-tx create still
// gets enqueued here, and anything left pending/failed is picked up by a
// later sweep or retry (#183).
//
// NEVER throws and NEVER touches the payment record: accounting export
// must not roll back a settled charge or block the response path.
export async function postPaidPaymentToQbo(paymentId: string): Promise<void> {
  try {
    const snap = await getFirebaseAdminDb()
      .collection(PAYMENTS_COLLECTION)
      .doc(paymentId)
      .get();
    const payment = snap.data();
    if (!payment) {
      logWarn("qbo.sync.skipped", { reason: "payment_missing", paymentId });
      return;
    }
    const status = normalizePaymentStatus(payment.status);
    if (status !== "paid" && status !== "refunded") {
      logInfo("qbo.sync.skipped", { reason: "not_ddb_settled", paymentId });
      return;
    }
    const { syncId } = await enqueueAccountingTransaction(
      qboStripePaymentCandidate(payment, paymentId)
    );
    await processQboSyncRecord(syncId);
  } catch (error) {
    // A deployment without QBO configured hits this on every paid
    // payment — warn, don't alarm. Genuine failures are errors.
    if (error instanceof QboError && error.kind === "configuration") {
      logWarn("qbo.sync.unavailable", { paymentId });
    } else {
      logError("qbo.sync.trigger_failed", error, { paymentId });
    }
  }
}
