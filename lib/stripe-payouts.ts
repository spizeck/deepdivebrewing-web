import "server-only";
import { randomUUID } from "node:crypto";
import {
  FieldPath,
  FieldValue,
  Timestamp,
  type DocumentReference,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { deepOmitUndefined } from "@/lib/firestore-safe";
import { isQboConfigured, getQboEnvironment } from "@/lib/qbo-config";
import { getQuickBooksAccessToken } from "@/lib/qbo-tokens";
import { getQboMappingView } from "@/lib/qbo-mapping";
import {
  fetchQboPaymentById,
  findQboUndepositedFundsAccount,
  queryQboInvoices,
  queryQboPayments,
  queryQboPaymentsByRefNum,
  queryQboReconActivity,
} from "@/lib/qbo-api";
import {
  QBO_RECON_ACTIVITY_ENTITIES,
  qboFeeEntryMarker,
} from "@/lib/qbo-protocol";
import {
  fetchStripePayout,
  fetchStripeChargeFacts,
  listRecentStripePayouts,
  listStripePayoutTransactions,
} from "@/lib/stripe-balance";
import {
  getStripeAccountingMode,
  getStripeAutomationCutover,
  isStripeConfigured,
  isStripeTestMode,
} from "@/lib/stripe-config";
import {
  buildDdbPaymentIndex,
  buildPayoutLedger,
  buildPayoutProposals,
  ollieIdentityFromChargeFacts,
  ollieRefsFromQboPayment,
  STRIPE_PAYOUT_LEDGER_TRIGGERS,
  STRIPE_PAYOUTS_COLLECTION,
  QBO_ACCOUNTING_PROPOSALS_COLLECTION,
  type BuiltPayoutLedger,
  type OllieStripeIdentity,
  type PayoutException,
  type QboAccountingProposal,
  type QboUndepositedPayment,
  type ReconciledPayment,
  type StripePayoutAutomationView,
  type StripePayoutFacts,
  type StripePayoutSyncItem,
  type StripePayoutSyncSummary,
  type StripePayoutView,
} from "@/lib/stripe-payouts-common";
import {
  PAYMENTS_COLLECTION,
  STRIPE_EVENTS_COLLECTION,
  timestampMillis,
} from "@/lib/payments-common";
import { applyPayoutProposal } from "@/lib/stripe-payout-executor";
import { logError, logInfo, logWarn } from "@/lib/log";
import { QboError } from "@/lib/qbo-errors";
import {
  QBO_STRIPE_PAYMENT_SOURCE_TYPE,
  QBO_SWEEP_STATE_COLLECTION,
  QBO_SYNC_RECORDS_COLLECTION,
  qboSyncIdFor,
  type QboEnvironment,
} from "@/lib/qbo-common";

// Stripe payout accounting orchestration. Everything here is Observe
// mode: payouts are ingested, canonicalized, classified, and turned into
// persisted accounting *proposals* — nothing posts to QuickBooks. The
// proposal records (and the `stripePayouts` ledger docs) are the audit
// surface an accountant reviews before any future execution PR.
//
// Boundaries:
//   - The webhook path does the minimum inside the request: dedupe, one
//     canonical payout fetch, one atomic write (status doc + event
//     marker). The ledger build runs after the response (route-level
//     `after()`), with the daily cron sweep as the recovery path for
//     anything dropped.
//   - Money fields come from authoritative Stripe reads only — the
//     webhook payload is never trusted beyond the object id.
//   - QBO writes do not exist in this module. There is no code path from
//     a proposal to a provider mutation in this build.

const PAYOUT_TXN_MAX_PAGES = 10;
// Stored `lines` array cap — the doc stays small; truncation is flagged.
const STORED_LINE_LIMIT = 200;
// DDB identity lookups: Firestore `in` caps at 30 values per query.
const IDENTITY_QUERY_CHUNK = 30;
const IDENTITY_QUERY_MAX_IDS = 150;
// Bounded provider enrichment for charges not already identity-linked.
const CHARGE_ENRICHMENT_BUDGET = 15;
// Recent payouts the admin view surfaces.
const PAYOUT_VIEW_LIMIT = 25;
const PROPOSAL_VIEW_LIMIT = 50;
// Sweep recovery: how far back to look and how many payouts to process
// per run — a daily cron must stay small.
export const PAYOUT_SWEEP_LOOKBACK_DAYS = 35;
export const PAYOUT_SWEEP_MAX_PROCESS = 5;
// The QBO payment window widens well past the payout arrival: Ollie can
// record a payment days before or after the Stripe charge settles.
const OLLIE_SCAN_LEAD_DAYS = 45;
const OLLIE_SCAN_LAG_DAYS = 7;
// Invoice DocNumber resolution for Ollie matching is bounded: at most
// this many linked invoice ids per payout, in IN-clause chunks.
const INVOICE_LOOKUP_MAX_IDS = 150;
const INVOICE_ID_CHUNK = 50;
// Targeted PaymentRefNum lookups for Spreedly-claimed references that
// fell outside the date-windowed candidate scan — bounded per build.
const SPREEDLY_LOOKUP_MAX = 5;

// Cross-payout claim lookup: `in` queries cap at 30 values (Firestore).
const CLAIMS_IN_CHUNK = 30;
// Proposal statuses that reserve a QBO payment for another payout —
// a blocked proposal still references its payment, so it claims too.
// Only `rejected` releases the payment back to the candidate pool.
const CLAIMING_STATUSES = new Set([
  "proposed",
  "blocked",
  "approved",
  "applied",
]);

// Stored-proposal scan page size (document-id ordering, no composite
// index needed) and the per-commit write bound — Firestore batches cap
// at 500 operations, and the ledger doc + proposals + stale marks for a
// pathological payout must fit in bounded chunks.
const PROPOSAL_SCAN_PAGE_SIZE = 200;
const BATCH_WRITE_LIMIT = 400;

const DAY_MS = 86_400_000;

function payoutRef(payoutId: string) {
  return getFirebaseAdminDb()
    .collection(STRIPE_PAYOUTS_COLLECTION)
    .doc(payoutId);
}

function proposalsCollection() {
  return getFirebaseAdminDb().collection(QBO_ACCOUNTING_PROPOSALS_COLLECTION);
}

function eventsCollection() {
  return getFirebaseAdminDb().collection(STRIPE_EVENTS_COLLECTION);
}

// --- Webhook ingestion (request-time work, deliberately small) ---

export interface PayoutEventResult {
  status: "applied" | "duplicate" | "ignored" | "retry";
  payoutId: string | null;
  /** True when the route should schedule `processStripePayoutLedger`
   *  via `after()` — the heavy ledger build runs outside the request. */
  needsLedgerBuild?: boolean;
  ignoredReason?: string;
}

// Records a verified payout event. Dedupe is the stripeEvents marker —
// the same collection the checkout-session flow uses — written in the
// same batch as the payout status doc so a crash cannot split them. The
// only provider call is one canonical payout retrieve; balance-
// transaction work is deferred to processStripePayoutLedger.
export async function recordStripePayoutEvent(input: {
  eventId: string;
  eventType: string;
  payoutId: string;
}): Promise<PayoutEventResult> {
  if (input.eventId) {
    const marker = await eventsCollection().doc(input.eventId).get();
    if (marker.exists) {
      return { status: "duplicate", payoutId: input.payoutId };
    }
  }

  const payout = await fetchStripePayout(input.payoutId).catch((error) => {
    // A transient provider failure must not be acknowledged — the route
    // answers 500 so Stripe redelivers.
    if (error instanceof QboError && error.kind === "unavailable") {
      return null;
    }
    throw error;
  });
  if (!payout) {
    return { status: "retry", payoutId: input.payoutId };
  }

  const needsLedger =
    STRIPE_PAYOUT_LEDGER_TRIGGERS.has(input.eventType) ||
    payout.status === "paid";

  const batch = getFirebaseAdminDb().batch();
  batch.set(
    payoutRef(payout.id),
    deepOmitUndefined({
      payoutId: payout.id,
      environment: getQboEnvironment(),
      status: payout.status,
      amountMinor: payout.amountMinor,
      currency: payout.currency,
      arrivalDate: payout.arrivalDate,
      method: payout.method,
      payoutType: payout.type,
      createdMs: payout.createdMs,
      pendingLedger: needsLedger,
      lastEventType: input.eventType,
      lastEventAt: FieldValue.serverTimestamp(),
    }),
    { merge: true }
  );
  if (input.eventId) {
    batch.set(eventsCollection().doc(input.eventId), {
      type: input.eventType,
      payoutId: payout.id,
      result: "payout_recorded",
      processedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();

  logInfo("stripe.payout.recorded", {
    payoutId: payout.id,
    eventType: input.eventType,
    status: payout.status,
    needsLedgerBuild: needsLedger,
  });
  return { status: "applied", payoutId: payout.id, needsLedgerBuild: needsLedger };
}

// --- Ledger construction (deferred work — `after()` or cron sweep) ---

// DDB positive identity for the payout's source objects: charge/refund/
// PaymentIntent ids the `payments` collection already recorded. Firestore
// `in` queries are chunked; over-cap sets degrade to fewer confirmed
// lines rather than scanning unboundedly.
interface DdbIdentityRecord {
  paymentId: string;
  chargeId?: string;
  paymentIntentId?: string;
  refundId?: string;
}

async function loadDdbIdentityRecords(
  txns: { sourceId?: string; type: string }[]
): Promise<{ records: DdbIdentityRecord[]; truncated: boolean }> {
  const sourceIds = [
    ...new Set(
      txns
        .map((txn) => txn.sourceId)
        .filter((id): id is string => Boolean(id))
    ),
  ].slice(0, IDENTITY_QUERY_MAX_IDS);
  const payments = getFirebaseAdminDb().collection(PAYMENTS_COLLECTION);
  const records: DdbIdentityRecord[] = [];
  const seen = new Set<string>();
  const collect = (doc: { id: string; data(): Record<string, unknown> }) => {
    if (seen.has(doc.id)) return;
    seen.add(doc.id);
    const data = doc.data();
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    records.push({
      paymentId: doc.id,
      chargeId: str(data.stripeChargeId),
      paymentIntentId: str(data.stripePaymentIntentId),
      refundId: str(data.stripeRefundId),
    });
  };
  const fields = ["stripeChargeId", "stripeRefundId", "stripePaymentIntentId"];
  for (const field of fields) {
    for (let i = 0; i < sourceIds.length; i += IDENTITY_QUERY_CHUNK) {
      const chunk = sourceIds.slice(i, i + IDENTITY_QUERY_CHUNK);
      const snap = await payments.where(field, "in", chunk).get();
      snap.docs.forEach(collect);
    }
  }
  return {
    records,
    truncated: sourceIds.length >= IDENTITY_QUERY_MAX_IDS,
  };
}

// The sync-record status for every resolved DDB payment — the durable
// record of whether its gross sale posted a QBO SalesReceipt. The ledger
// flags any `ddb` line that cannot prove its receipt (missing record,
// pending, failed, needs_attention) instead of letting a balanced payout
// read as fully reconciled. Document ids are deterministic
// (`environment:stripe_payment:<paymentId>`), so chunked document-id
// `in` queries fetch exactly the records that could exist.
async function loadDdbReceiptStatuses(
  environment: QboEnvironment,
  records: DdbIdentityRecord[]
): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  const paymentIds = [
    ...new Set(records.map((record) => record.paymentId)),
  ];
  const syncIds = paymentIds.map((paymentId) =>
    qboSyncIdFor(environment, QBO_STRIPE_PAYMENT_SOURCE_TYPE, paymentId)
  );
  const idToPayment = new Map(syncIds.map((id, i) => [id, paymentIds[i]]));
  const collection = getFirebaseAdminDb().collection(
    QBO_SYNC_RECORDS_COLLECTION
  );
  for (let i = 0; i < syncIds.length; i += IDENTITY_QUERY_CHUNK) {
    const chunk = syncIds.slice(i, i + IDENTITY_QUERY_CHUNK);
    const snap = await collection
      .where(FieldPath.documentId(), "in", chunk)
      .get();
    for (const doc of snap.docs) {
      const paymentId = idToPayment.get(doc.id);
      const data = doc.data();
      const status = data.status;
      if (paymentId && typeof status === "string") {
        // `synced` only proves the receipt posted when the record carries
        // the QBO entity it created — a bare `synced` with no entity id
        // is unfinished evidence, not confirmation.
        statuses.set(
          paymentId,
          status === "synced" &&
            !(typeof data.qboEntityId === "string" && data.qboEntityId)
            ? "synced_no_entity"
            : status
        );
      }
    }
  }
  return statuses;
}

// Enrichment for charge sources that resolved nothing — one bounded
// retrieve each. Resolved payment records are pushed onto `records` so
// the index rebuilt afterwards carries their intent ids; the returned
// map additionally hands the ledger each source's PaymentIntent so an
// intent-only payment record still confirms identity.
async function enrichChargeSources(
  txns: { sourceId?: string; type: string }[],
  records: DdbIdentityRecord[]
) {
  const knownSources = new Set(
    records.flatMap((record) =>
      [record.chargeId, record.refundId].filter(
        (id): id is string => Boolean(id)
      )
    )
  );
  const knownPaymentIds = new Set(records.map((record) => record.paymentId));
  const resolved = new Map<
    string,
    {
      paymentIntentId?: string;
      paymentId?: string;
      ollieIdentity?: OllieStripeIdentity;
    }
  >();
  let budget = CHARGE_ENRICHMENT_BUDGET;
  for (const txn of txns) {
    const source = txn.sourceId;
    if (
      !source ||
      budget <= 0 ||
      (txn.type !== "charge" && txn.type !== "payment") ||
      knownSources.has(source)
    ) {
      continue;
    }
    budget -= 1;
    try {
      const facts = await fetchStripeChargeFacts(source);
      resolved.set(source, {
        paymentIntentId: facts.paymentIntentId,
        paymentId: facts.paymentId,
        ollieIdentity: ollieIdentityFromChargeFacts(facts),
      });
      // The app writes `metadata.paymentId` at session creation — when it
      // resolves to a stored payments doc that record joins the identity
      // index so the charge confirms without further lookups.
      if (facts.paymentId && !knownPaymentIds.has(facts.paymentId)) {
        const snap = await getFirebaseAdminDb()
          .collection(PAYMENTS_COLLECTION)
          .doc(facts.paymentId)
          .get();
        if (snap.exists) {
          const data = snap.data() ?? {};
          const str = (v: unknown) =>
            typeof v === "string" && v ? v : undefined;
          records.push({
            paymentId: snap.id,
            chargeId: str(data.stripeChargeId) ?? source,
            paymentIntentId: str(data.stripePaymentIntentId),
            refundId: str(data.stripeRefundId),
          });
          knownPaymentIds.add(snap.id);
        }
      }
    } catch {
      // An enrichment failure leaves the source unresolved — the ledger
      // classifies it through the Ollie path or reports it unmatched.
    }
  }
  return resolved;
}

// The Ollie half: payments still sitting in Undeposited Funds inside the
// payout's plausible window, minus the ids other payouts already claim.
// Best-effort — an unavailable QBO leg yields no candidates, never a
// guessed account.
async function fetchOllieLeg(
  environment: QboEnvironment,
  payout: StripePayoutFacts,
  claimedPaymentRefs: string[] = []
): Promise<{
  candidates: QboUndepositedPayment[];
  claimedByOthers: Set<string>;
  available: boolean;
  undepositedFundsId?: string;
}> {
  const empty = {
    candidates: [],
    claimedByOthers: new Set<string>(),
    available: false,
  };
  if (!isQboConfigured()) return empty;
  try {
    const token = await getQuickBooksAccessToken();
    const uf = await findQboUndepositedFundsAccount({ ...token, environment });
    if (!uf) {
      // Cannot identify UF — fail closed. No candidates rather than risk
      // matching a payment that already deposited to a bank account.
      return empty;
    }
    const base =
      typeof payout.createdMs === "number"
        ? payout.createdMs
        : Date.parse(`${payout.arrivalDate}T00:00:00.000Z`);
    const anchor = Number.isNaN(base) ? Date.now() : base;
    const from = new Date(anchor - OLLIE_SCAN_LEAD_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const to = new Date(anchor + OLLIE_SCAN_LAG_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const { rows } = await queryQboPayments({
      ...token,
      environment,
      fromDate: from,
      toDate: to,
      maxPages: 3,
    });
    // Undeposited Funds candidates: payments depositing into the
    // discovered UF account, plus payments carrying no deposit target —
    // QBO defaults an unset DepositToAccountRef to UF.
    const candidates: QboUndepositedPayment[] = rows
      .filter(
        (payment) =>
          !payment.depositToAccountId ||
          payment.depositToAccountId === uf.id
      )
      .map((payment) => ({
        id: payment.id,
        txnDate: payment.txnDate,
        totalMinor: payment.totalMinor,
        depositToAccountId: payment.depositToAccountId,
        currency: payment.currency,
        customerId: payment.customerId,
        customerName: payment.customerName,
        refNumber: payment.refNumber,
        memo: payment.memo,
        linkedTxnIds: payment.linkedTxnIds,
      }));

    // Spreedly-claimed payment references that the window scan missed —
    // a charge's metadata names the payment it believes it is, so a
    // claim pointing outside the window is investigated with a targeted
    // PaymentRefNum lookup instead of silently matching nothing. The
    // same UF and claim filters apply; a claimed payment that has
    // already been deposited elsewhere is not a candidate (its durable
    // reconciliation evidence, if any, owns the relationship).
    const hasRef = (payment: QboUndepositedPayment, ref: string) =>
      ollieRefsFromQboPayment(payment).paymentNumbers.includes(ref);
    const missing = claimedPaymentRefs
      .filter(
        (ref, i) =>
          claimedPaymentRefs.indexOf(ref) === i &&
          !candidates.some((payment) => hasRef(payment, ref))
      )
      .slice(0, SPREEDLY_LOOKUP_MAX);
    for (const ref of missing) {
      try {
        const extra = await queryQboPaymentsByRefNum({
          ...token,
          environment,
          refNum: ref,
        });
        for (const payment of extra) {
          if (candidates.some((candidate) => candidate.id === payment.id)) {
            continue;
          }
          if (
            payment.depositToAccountId &&
            payment.depositToAccountId !== uf.id
          ) {
            continue;
          }
          candidates.push({
            id: payment.id,
            txnDate: payment.txnDate,
            totalMinor: payment.totalMinor,
            depositToAccountId: payment.depositToAccountId,
            currency: payment.currency,
            customerId: payment.customerId,
            customerName: payment.customerName,
            refNumber: payment.refNumber,
            memo: payment.memo,
            linkedTxnIds: payment.linkedTxnIds,
          });
        }
      } catch (error) {
        // A failed lookup leaves the claim unresolved — the line falls
        // back to normal suggested/ambiguous matching, review-required.
        logWarn("stripe.payout.spreedly_lookup_failed", {
          environment,
          paymentRef: ref,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Resolve the DocNumber of every invoice the candidates link to —
    // the invoice number equals the Ollie order number, which is the
    // Stripe-side identifier that can verify a match. Bounded: the
    // lookup scans at most INVOICE_LOOKUP_MAX_IDS ids in IN-clause
    // chunks, and a lookup failure degrades to suggested-only matching
    // rather than failing the leg.
    const linkedIds = [
      ...new Set(candidates.flatMap((payment) => payment.linkedTxnIds)),
    ].slice(0, INVOICE_LOOKUP_MAX_IDS);
    try {
      const docByInvoiceId = new Map<string, string>();
      for (let i = 0; i < linkedIds.length; i += INVOICE_ID_CHUNK) {
        const invoices = await queryQboInvoices({
          ...token,
          environment,
          ids: linkedIds.slice(i, i + INVOICE_ID_CHUNK),
        });
        for (const invoice of invoices) {
          if (invoice.docNumber) docByInvoiceId.set(invoice.id, invoice.docNumber);
        }
      }
      for (const payment of candidates) {
        const docNumbers = payment.linkedTxnIds
          .map((id) => docByInvoiceId.get(id))
          .filter((doc): doc is string => Boolean(doc));
        if (docNumbers.length) payment.linkedDocNumbers = docNumbers;
      }
    } catch (error) {
      // Supplementary evidence only — matching continues on
      // amount/date/refNumber, just without the invoice-order chain.
      logWarn("stripe.payout.invoice_lookup_failed", {
        environment,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Payments another payout's live proposals already claim — a payment
    // must never appear on two payouts' proposal sets. Query claims by the
    // candidate payment ids themselves (chunked `in` lookups): an
    // unfiltered cap-500 scan can silently drop claims once the live set
    // grows past the page size, and cross-environment proposals never
    // share QBO payments anyway.
    const claimedByOthers = new Set<string>();
    const candidateIds = candidates.map((payment) => payment.id);
    for (let i = 0; i < candidateIds.length; i += CLAIMS_IN_CHUNK) {
      const chunk = candidateIds.slice(i, i + CLAIMS_IN_CHUNK);
      const claims = await proposalsCollection()
        .where("qboRefs.paymentId", "in", chunk)
        .get();
      for (const doc of claims.docs) {
        const data = doc.data();
        if (
          data.payoutId === payout.id ||
          data.environment !== environment ||
          data.kind !== "move_payment_to_clearing" ||
          !CLAIMING_STATUSES.has(data.status)
        ) {
          continue;
        }
        claimedByOthers.add(data.qboRefs.paymentId);
      }
    }
    return {
      candidates,
      claimedByOthers,
      available: true,
      undepositedFundsId: uf.id,
    };
  } catch (error) {
    const quiet =
      error instanceof QboError &&
      (error.kind === "configuration" ||
        error.kind === "validation" ||
        error.kind === "authorization_expired");
    if (!quiet) {
      logError("stripe.payout.qbo_leg_failed", error, { environment });
    }
    return empty;
  }
}

// Detects owner-entered manual equivalents inside the payout window — a
// fee Purchase/journal matching the fee total, or a Transfer/Deposit
// touching clearing at exactly the payout amount. Exact-amount matching
// only: false suppression silently hides a needed proposal, so loose
// heuristics are worse than none.
async function detectExistingCover(
  environment: QboEnvironment,
  payout: StripePayoutFacts,
  ledger: BuiltPayoutLedger,
  mapping: {
    stripeClearingAccountId?: string;
    stripeFeeExpenseAccountId?: string;
  }
): Promise<{
  hasFeeEntry: boolean;
  hasTransferEntry: boolean;
  hasHistoricalFeeEntry: boolean;
}> {
  const none = {
    hasFeeEntry: false,
    hasTransferEntry: false,
    hasHistoricalFeeEntry: false,
  };
  const watched = new Set(
    [
      mapping.stripeClearingAccountId,
      mapping.stripeFeeExpenseAccountId,
    ].filter((id): id is string => Boolean(id))
  );
  if (!watched.size || !isQboConfigured()) return none;
  try {
    const token = await getQuickBooksAccessToken();
    const anchor = payout.createdMs ?? Date.now();
    const from = new Date(anchor - OLLIE_SCAN_LEAD_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const to = new Date(anchor + OLLIE_SCAN_LAG_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const scans = await Promise.all(
      QBO_RECON_ACTIVITY_ENTITIES.map((entity) =>
        queryQboReconActivity({ ...token, environment, entity, fromDate: from, toDate: to })
      )
    );
    // What a fee proposal would actually carry — on a cutover-straddling
    // payout the eligible proposal covers the eligible-line fee sum and
    // the historical proposal covers the pre-cutover sum. A manual entry
    // matching the ledger total covers both shares.
    const eligibleFeesMinor = ledger.lines
      .filter((line) => line.scope === "eligible")
      .reduce((sum, line) => sum + line.feeMinor, 0);
    const preCutoverFeesMinor = ledger.lines
      .filter((line) => line.scope === "pre_cutover")
      .reduce((sum, line) => sum + line.feeMinor, 0);
    const coveredFeeAmounts = new Set(
      [ledger.totals.feesMinor, eligibleFeesMinor].filter((n) => n > 0)
    );
    const coveredHistoricalFeeAmounts = new Set(
      [ledger.totals.feesMinor, preCutoverFeesMinor].filter((n) => n > 0)
    );
    // On a straddling payout the two shares post under disjoint marker
    // namespaces — an entry stamped with one share's marker must not
    // read as coverage for the other share, even when the amounts
    // coincide. Unmarked (manual) entries count for either.
    const eligibleFeeMarker = qboFeeEntryMarker(payout.id);
    const historicalFeeMarker = qboFeeEntryMarker(payout.id, true);
    let hasFeeEntry = false;
    let hasTransferEntry = false;
    let hasHistoricalFeeEntry = false;
    for (const scan of scans) {
      for (const entry of scan.rows) {
        const hits = entry.legs.filter((leg) => watched.has(leg.accountId));
        if (!hits.length) continue;
        const feeLeg = hits.find(
          (leg) => leg.accountId === mapping.stripeFeeExpenseAccountId
        );
        if (feeLeg) {
          const feeAmount = Math.abs(feeLeg.amountMinor);
          const memo = entry.memo ?? "";
          const markedEligible = memo.includes(eligibleFeeMarker);
          const markedHistorical = memo.includes(historicalFeeMarker);
          if (!markedHistorical && coveredFeeAmounts.has(feeAmount)) {
            hasFeeEntry = true;
          }
          if (
            !markedEligible &&
            coveredHistoricalFeeAmounts.has(feeAmount)
          ) {
            hasHistoricalFeeEntry = true;
          }
        }
        const transferLeg = hits.find(
          (leg) => leg.accountId === mapping.stripeClearingAccountId
        );
        if (
          transferLeg &&
          Math.abs(transferLeg.amountMinor) === payout.amountMinor &&
          (entry.entityType === "Transfer" || entry.entityType === "Deposit")
        ) {
          hasTransferEntry = true;
        }
      }
    }
    return { hasFeeEntry, hasTransferEntry, hasHistoricalFeeEntry };
  } catch {
    return none;
  }
}

// Proposals already decided by an authorized admin must never be
// silently overwritten back to "proposed" by a ledger rebuild — the
// execution surface (follow-up PR) flips these and a recompute must
// respect them.

// Durable reconciliation evidence for the ledger build: payments this
// payout already reclassified through an *applied* move proposal leave
// the Undeposited Funds candidate set permanently, so a rebuild that
// relied on matching alone would demote the line to `external/unmatched`
// and forget a completed reconciliation. The applied proposal doc is
// the authoritative record — the payment id required explicit admin
// confirmation and the executor's apply-time revalidation before it
// ever ran. Each recorded relationship is then checked against live
// QBO state: confirmed, contradicted (`conflict` → exception), or
// unreachable (`unverified` — an outage is not evidence).
async function loadReconciledMoves(
  environment: QboEnvironment,
  proposalDocs: QueryDocumentSnapshot[],
  ollie: { available: boolean; undepositedFundsId?: string }
): Promise<Map<string, ReconciledPayment>> {
  const records = new Map<
    string,
    {
      paymentId: string;
      paymentRef?: string;
      confidence: ReconciledPayment["confidence"];
      identityRefs?: string[];
      expectedAccountId?: string;
      amountMinor: number;
      currency: string;
    }
  >();
  for (const doc of proposalDocs) {
    const data = doc.data() as QboAccountingProposal;
    if (
      data.kind !== "move_payment_to_clearing" ||
      data.status !== "applied"
    ) {
      continue;
    }
    const txnId = data.stripeRefs?.balanceTxnId;
    const paymentId = data.qboRefs?.paymentId;
    if (!txnId || !paymentId || records.has(txnId)) continue;
    records.set(txnId, {
      paymentId,
      paymentRef: data.qboRefs?.paymentRef,
      confidence:
        data.lineConfidence === "verified" ||
        data.lineConfidence === "confirmed"
          ? data.lineConfidence
          : "suggested",
      identityRefs: data.stripeRefs?.identity
        ? data.stripeRefs.identity.split(",")
        : undefined,
      expectedAccountId: data.debit?.accountId,
      amountMinor: data.amountMinor,
      currency: data.currency,
    });
  }
  const result = new Map<string, ReconciledPayment>();
  if (!records.size) return result;
  if (!ollie.available) {
    // No QBO leg this run — keep the recorded identities (an outage is
    // not evidence) but mark every one unverified.
    for (const [txnId, rec] of records) {
      result.set(txnId, { ...rec, state: "unverified" });
    }
    return result;
  }
  let token: Awaited<ReturnType<typeof getQuickBooksAccessToken>>;
  try {
    token = await getQuickBooksAccessToken();
  } catch {
    for (const [txnId, rec] of records) {
      result.set(txnId, { ...rec, state: "unverified" });
    }
    return result;
  }
  for (const [txnId, rec] of records) {
    const base = {
      paymentId: rec.paymentId,
      paymentRef: rec.paymentRef,
      confidence: rec.confidence,
      identityRefs: rec.identityRefs,
    };
    try {
      const payment = await fetchQboPaymentById({
        ...token,
        environment,
        paymentId: rec.paymentId,
      });
      if (!payment) {
        result.set(txnId, {
          ...base,
          state: "conflict",
          conflictDetail: `QBO payment ${rec.paymentId} no longer exists — the recorded reclassification cannot be confirmed. Investigate before further accounting.`,
        });
        continue;
      }
      if (payment.totalMinor !== rec.amountMinor) {
        result.set(txnId, {
          ...base,
          state: "conflict",
          conflictDetail: `QBO payment ${rec.paymentId} now totals ${payment.totalMinor} minor units vs the recorded ${rec.amountMinor} — the recorded reclassification no longer matches live state.`,
        });
        continue;
      }
      if (
        payment.currency &&
        payment.currency !== rec.currency.toUpperCase()
      ) {
        result.set(txnId, {
          ...base,
          state: "conflict",
          conflictDetail: `QBO payment ${rec.paymentId} currency changed to ${payment.currency} vs the recorded ${rec.currency}.`,
        });
        continue;
      }
      if (
        rec.expectedAccountId &&
        payment.depositToAccountId === rec.expectedAccountId
      ) {
        result.set(txnId, {
          ...base,
          paymentRef: rec.paymentRef ?? payment.refNumber ?? undefined,
          state: "applied",
        });
        continue;
      }
      if (
        ollie.undepositedFundsId &&
        payment.depositToAccountId === ollie.undepositedFundsId
      ) {
        result.set(txnId, {
          ...base,
          state: "conflict",
          conflictDetail: `QBO payment ${rec.paymentId} is back in Undeposited Funds though its reclassification was applied — possible manual reversal; investigate before proposing again.`,
        });
        continue;
      }
      result.set(txnId, {
        ...base,
        state: "conflict",
        conflictDetail: `QBO payment ${rec.paymentId} sits in account ${payment.depositToAccountId ?? "(none)"}, not the recorded destination — the reconciliation may have been altered outside this workflow.`,
      });
    } catch (error) {
      logWarn("stripe.payout.reconciled_read_failed", {
        environment,
        paymentId: rec.paymentId,
        error: error instanceof Error ? error.message : String(error),
      });
      result.set(txnId, { ...base, state: "unverified" });
    }
  }
  return result;
}

// What one canonical build produced — returned so the manual sync can
// report ingestion vs proposal eligibility honestly (a fully pre-cutover
// payout ingests cleanly and proposes nothing).
export interface StripePayoutLedgerResult {
  status: string;
  lineCount: number;
  eligibleLineCount: number;
  preCutoverLineCount: number;
  proposalCount: number;
}

export async function processStripePayoutLedger(
  payoutId: string
): Promise<StripePayoutLedgerResult | null> {
  const environment = getQboEnvironment();
  const mode = getStripeAccountingMode();
  const cutover = getStripeAutomationCutover();
  const payout = await fetchStripePayout(payoutId);
  if (!payout) {
    logWarn("stripe.payout.ledger_missing", { payoutId });
    return null;
  }

  const statusOnly = !["paid"].includes(payout.status);
  const { txns, truncated } = statusOnly
    ? { txns: [], truncated: false }
    : await listStripePayoutTransactions(payoutId, PAYOUT_TXN_MAX_PAGES);

  const { records: ddbRecords } = await loadDdbIdentityRecords(txns);
  const resolvedChargeFacts = await enrichChargeSources(txns, ddbRecords);
  const index = buildDdbPaymentIndex(ddbRecords);
  const ddbReceiptStatus = await loadDdbReceiptStatuses(
    environment,
    ddbRecords
  );
  // Payment references the charges' Spreedly metadata claims — the QBO
  // leg investigates any that the date-windowed scan missed.
  const claimedPaymentRefs = [
    ...new Set(
      [...resolvedChargeFacts.values()]
        .map((facts) => facts.ollieIdentity?.spreedly?.paymentRef)
        .filter((ref): ref is string => Boolean(ref))
    ),
  ];
  const ollie = await fetchOllieLeg(environment, payout, claimedPaymentRefs);

  // The stored proposal set is read once and serves two purposes: it is
  // the durable evidence the ledger build uses to keep already-reconciled
  // payments identified (applied moves — see `loadReconciledMoves`), and
  // the live-state snapshot the merge/stale pass below writes against.
  // Docs are paged by document id (equality filters + document-id
  // ordering need no composite index) so a payout holding more than one
  // page of proposals is scanned completely.
  const existingDocs: QueryDocumentSnapshot[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let pageQuery = proposalsCollection()
      .where("payoutId", "==", payoutId)
      .where("environment", "==", environment)
      .orderBy(FieldPath.documentId())
      .limit(PROPOSAL_SCAN_PAGE_SIZE);
    if (cursor) pageQuery = pageQuery.startAfter(cursor);
    const snap = await pageQuery.get();
    existingDocs.push(...snap.docs);
    if (snap.size < PROPOSAL_SCAN_PAGE_SIZE) break;
    cursor = snap.docs[snap.docs.length - 1];
  }

  const reconciledMoves = await loadReconciledMoves(
    environment,
    existingDocs,
    ollie
  );

  const ledger = buildPayoutLedger({
    payout,
    txns,
    ddbIndex: index,
    resolvedChargeFacts,
    ollieCandidates: ollie.candidates,
    claimedPaymentIds: ollie.claimedByOthers,
    ddbReceiptStatus,
    reconciledMoves,
    cutover,
  });

  const mappingView = ollie.available ? await getQboMappingView() : null;
  const mapping = {
    stripeClearingAccountId:
      mappingView?.mapping?.stripeClearingAccountId,
    stripeFeeExpenseAccountId:
      mappingView?.mapping?.stripeFeeExpenseAccountId,
    stripePayoutAccountId:
      mappingView?.mapping?.stripePayoutAccountId,
  };
  const existingCover = await detectExistingCover(
    environment,
    payout,
    ledger,
    mapping
  );

  const proposals = buildPayoutProposals({
    environment,
    payout,
    ledger,
    mode,
    mapping,
    accountNames: mappingView?.entityNames ?? {},
    existingCover,
    undepositedFundsId: ollie.undepositedFundsId,
    ledgerComplete: !truncated,
  });

  // Proposal persistence: deterministic ids make every rewrite idempotent
  // — a replayed event or second trigger converges to the same docs. The
  // `existingDocs` snapshot was scanned before the build (it doubles as
  // the reconciliation-evidence source); the merge/stale pass below
  // still re-reads live docs inside per-document transactions, so a
  // decision committed after the snapshot cannot be overwritten.
  // Writes collect into bounded batches — a pathological payout could
  // hold hundreds of proposals, and a batch caps at 500 operations.
  const writes: { ref: DocumentReference; data: Record<string, unknown> }[] =
    [];
  const now = new Date().toISOString();

  // Proposals that no longer recompute (e.g. a line went pre-cutover, a
  // match resolved elsewhere) are stale — not deleted, which would erase
  // review history, and not left at a live status, which would let a
  // future execution surface pick them up. `stale` is not a decided
  // status, so a proposal that recomputes on a later build revives.
  // Terminal decisions (`rejected`, `applied`) are never touched — and a
  // `move_payment_to_clearing` absence is only trusted when the QBO leg
  // actually ran: with QBO unavailable there were no candidates to match,
  // so a missing proposal is an outage artifact, not evidence.
  const recomputedIds = new Set(proposals.map((p) => p.proposalId));
  const staleTargets: string[] = [];
  for (const doc of existingDocs) {
    const data = doc.data();
    const status = data.status;
    if (
      recomputedIds.has(doc.id) ||
      (status !== "proposed" && status !== "blocked" && status !== "approved")
    ) {
      continue;
    }
    if (!ollie.available && data.kind === "move_payment_to_clearing") {
      continue;
    }
    staleTargets.push(doc.id);
  }
  // Every proposal write runs in a per-document transaction that re-reads
  // live state: a decision committed after the `existingDocs` snapshot — or
  // a doc created and decided by a concurrent build — must not be
  // overwritten by a rebuild working from stale state.
  const mergeProposals: QboAccountingProposal[] = [...proposals];
  const computedEntry = {
    at: now,
    actor: "system",
    note: `computed in ${mode} mode`,
  };
  // Automatic mode self-applies only proposals the builder marked
  // `autoEligible` — verified-identifier moves and aggregates whose
  // payout is fully identified and fully in-scope. The apply still runs
  // the executor's full claim/fingerprint/revalidation path; `auto` only
  // supplies the approval the mode was designed to make unnecessary.
  const autoTargets: {
    proposalId: string;
    status: string;
    autoEligible: boolean;
  }[] = [];

  const lines = ledger.lines.slice(0, STORED_LINE_LIMIT);
  const laneCounts = { ddb: 0, ollie: 0, external: 0, accountLevel: 0 };
  for (const line of ledger.lines) {
    if (line.lane === "account_level") laneCounts.accountLevel += 1;
    else laneCounts[line.lane] += 1;
  }
  const exceptions: PayoutException[] = ledger.exceptions.slice(0, 100);
  if (truncated) {
    exceptions.push({
      code: "unmatched_movement",
      ref: payout.id,
      detail:
        "Payout transaction list was truncated — the persisted ledger is partial.",
    });
  }

  writes.push({
    ref: payoutRef(payout.id),
    data: deepOmitUndefined({
      payoutId: payout.id,
      environment,
      status: payout.status,
      amountMinor: payout.amountMinor,
      currency: payout.currency,
      arrivalDate: payout.arrivalDate,
      method: payout.method,
      payoutType: payout.type,
      createdMs: payout.createdMs,
      pendingLedger: false,
      // A full rebuild resolves any outstanding automatic-apply retry —
      // the post-build apply pass sets this back to true if unattended
      // work remains.
      pendingAutoApply: false,
      automationMode: mode,
      totals: ledger.totals,
      laneCounts,
      lines,
      linesTruncated:
        ledger.lines.length > STORED_LINE_LIMIT || truncated,
      exceptions,
      qboAvailable: ollie.available,
      lastProcessedAt: FieldValue.serverTimestamp(),
      lastProcessedIso: now,
    }),
  });
  for (let i = 0; i < writes.length; i += BATCH_WRITE_LIMIT) {
    const batch = getFirebaseAdminDb().batch();
    for (const write of writes.slice(i, i + BATCH_WRITE_LIMIT)) {
      batch.set(write.ref, write.data, { merge: true });
    }
    await batch.commit();
  }

  // Stale marks on existing docs run as per-document transactions so a
  // decision committed after the snapshot is seen — a doc whose status
  // moved to a decided state since the scan is left alone rather than
  // force-marked stale from the stale snapshot.
  const db = getFirebaseAdminDb();
  for (const proposalId of staleTargets) {
    const ref = proposalsCollection().doc(proposalId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const live = snap.data() ?? {};
      const liveStatus = live.status;
      if (
        liveStatus !== "proposed" &&
        liveStatus !== "blocked" &&
        liveStatus !== "approved"
      ) {
        return;
      }
      const trail = [
        ...(Array.isArray(live.auditTrail)
          ? (live.auditTrail as { at: string; actor: string; note: string }[])
          : []),
        {
          at: now,
          actor: "system",
          note: `no longer produced by the latest build — marked stale (was ${liveStatus})`,
        },
      ];
      tx.set(
        ref,
        { status: "stale", auditTrail: trail.slice(-20) },
        { merge: true }
      );
    });
  }

  // Recomputed proposals merge against the live doc inside a
  // transaction: a stored `approved` decision only carries forward while
  // the fingerprint it was recorded against still matches the freshly
  // computed material facts. A materially changed proposal drops back to
  // its computed status (`proposed`, or `blocked` when the rebuild's
  // mapping no longer resolves) and needs a fresh approval. Terminal
  // statuses (`rejected`, `applied`) are never touched.
  for (const proposal of mergeProposals) {
    const ref = proposalsCollection().doc(proposal.proposalId);
    let finalStatus = proposal.status;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const live = snap.exists ? (snap.data() ?? {}) : {};
      const trail = [
        ...(Array.isArray(live.auditTrail)
          ? (live.auditTrail as { at: string; actor: string; note: string }[])
          : []),
        computedEntry,
      ];
      let status = proposal.status;
      let clearDecision = false;
      const liveStatus = live.status;
      if (liveStatus === "rejected" || liveStatus === "applied") {
        status = liveStatus;
      } else if (liveStatus === "approved") {
        const liveDecision = live.decision;
        const approvedFingerprint =
          typeof liveDecision === "object" && liveDecision !== null
            ? (liveDecision as { fingerprint?: string }).fingerprint
            : undefined;
        // An automation-granted approval only stands while the proposal
        // still qualifies for unattended execution. The fingerprint
        // binds material facts — amount, accounts, references — but not
        // the evidence tier that let the system approve without review;
        // a rebuild that loses that eligibility (same fee amount, weaker
        // identification) must not leave the system approval executable.
        const automationGranted =
          typeof liveDecision === "object" &&
          liveDecision !== null &&
          ((liveDecision as { auto?: boolean }).auto === true ||
            (liveDecision as { actorUid?: string }).actorUid ===
              "automation");
        if (
          approvedFingerprint === proposal.materialFingerprint &&
          (!automationGranted || proposal.autoEligible === true)
        ) {
          status = "approved";
        } else {
          // The recorded approval no longer binds these material facts —
          // clear the current `decision` so the doc can't read as
          // "proposed but approved". `decisions[]` still keeps the
          // superseded record.
          clearDecision = true;
          trail.push({
            at: now,
            actor: "system",
            note:
              approvedFingerprint === proposal.materialFingerprint
                ? "proposal no longer qualifies for unattended execution — automation approval invalidated, requires a fresh decision"
                : approvedFingerprint
                  ? "material facts changed since approval — approval invalidated, proposal requires a fresh decision"
                  : "approval predates fingerprint binding — proposal requires a fresh decision",
          });
        }
      }
      finalStatus = status;
      tx.set(
        ref,
        deepOmitUndefined({
          ...proposal,
          status,
          computedAt: FieldValue.serverTimestamp(),
          auditTrail: trail.slice(-20),
          ...(clearDecision ? { decision: FieldValue.delete() } : {}),
        }),
        { merge: true }
      );
    });
    autoTargets.push({
      proposalId: proposal.proposalId,
      status: finalStatus,
      autoEligible: proposal.autoEligible === true,
    });
  }

  logInfo("stripe.payout.ledger_built", {
    payoutId: payout.id,
    lines: ledger.lines.length,
    proposals: proposals.length,
    exceptions: exceptions.length,
    balanced: ledger.totals.balanced,
  });

  // Automatic mode: apply the proposals whose evidence tier qualifies
  // for unattended execution. Every apply still runs the full guarded
  // path — claim lease, fingerprint binding, QBO revalidation, recovery
  // lookup — and a per-proposal failure is recorded, never fatal to the
  // ledger build.
  if (mode === "automatic") {
    let applied = 0;
    let pending = 0;
    // Outcomes a later pass can still complete: transient executor
    // failures, uncertain provider results, and claims held by a
    // still-live lease. `refused` is a gate rejection needing a human —
    // retrying it automatically would just burn the next sweep.
    let retryable = 0;
    for (const target of autoTargets) {
      if (
        !target.autoEligible ||
        (target.status !== "proposed" && target.status !== "approved")
      ) {
        continue;
      }
      try {
        const res = await applyPayoutProposal({
          proposalId: target.proposalId,
          actor: { uid: "stripe-payout-automation" },
          auto: true,
        });
        if (
          res.apply.outcome === "applied" ||
          res.apply.outcome === "already_applied"
        ) {
          applied++;
        } else {
          pending++;
          if (
            res.apply.outcome === "failed" ||
            res.apply.outcome === "uncertain" ||
            res.apply.outcome === "in_progress"
          ) {
            retryable++;
          }
        }
      } catch (error) {
        pending++;
        retryable++;
        logError("stripe.payout.auto_apply_failed", error, {
          payoutId: payout.id,
          proposalId: target.proposalId,
        });
      }
    }
    // Durable retry signal: a transient failure must not disappear with
    // the build result. The payout doc carries `pendingAutoApply` so the
    // sweep and manual sync revisit the payout instead of treating it
    // as fully processed.
    if (retryable > 0) {
      await payoutRef(payout.id).set(
        { pendingAutoApply: true },
        { merge: true }
      );
    }
    if (applied || pending) {
      logInfo("stripe.payout.auto_apply", {
        payoutId: payout.id,
        applied,
        pending,
        retryable,
      });
    }
  }
  return {
    status: payout.status,
    lineCount: ledger.lines.length,
    eligibleLineCount: ledger.lines.filter(
      (line) => line.scope === "eligible"
    ).length,
    preCutoverLineCount: ledger.lines.filter(
      (line) => line.scope === "pre_cutover"
    ).length,
    proposalCount: proposals.length,
  };
}

// --- Admin view ---

function toIsoString(value: unknown): string | undefined {
  return value instanceof Timestamp
    ? value.toDate().toISOString()
    : undefined;
}

function toPayoutView(
  docId: string,
  data: Record<string, unknown>
): StripePayoutView {
  const proposalCount =
    typeof data.proposalCount === "number" ? data.proposalCount : 0;
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const laneCounts = (data.laneCounts ?? {}) as Record<string, number>;
  const proposalsArr = Array.isArray(data.proposals) ? data.proposals : [];
  return {
    payoutId: docId,
    status: typeof data.status === "string" ? data.status : "unknown",
    amountMinor:
      typeof data.amountMinor === "number" ? data.amountMinor : 0,
    currency: typeof data.currency === "string" ? data.currency : "USD",
    arrivalDate:
      typeof data.arrivalDate === "string" ? data.arrivalDate : undefined,
    automationMode:
      data.automationMode === "approval" || data.automationMode === "automatic"
        ? data.automationMode
        : "observe",
    totals: (data.totals as StripePayoutView["totals"]) ?? {
      lineCount: 0,
      chargeCount: 0,
      grossChargesMinor: 0,
      feesMinor: 0,
      refundCount: 0,
      refundsMinor: 0,
      adjustmentMinor: 0,
      otherCount: 0,
      computedNetMinor: 0,
      payoutAmountMinor:
        typeof data.amountMinor === "number" ? data.amountMinor : 0,
      balanced: false,
      currencyConsistent: true,
    },
    laneCounts: {
      ddb: laneCounts.ddb ?? 0,
      ollie: laneCounts.ollie ?? 0,
      external: laneCounts.external ?? 0,
      accountLevel: laneCounts.accountLevel ?? 0,
    },
    matchedPayments:
      (laneCounts.ddb ?? 0) + (laneCounts.ollie ?? 0),
    unmatchedMovements: laneCounts.external ?? 0,
    exceptionsCount: Array.isArray(data.exceptions)
      ? data.exceptions.length
      : 0,
    proposalCount,
    proposedCount: proposalsArr.filter(
      (p) => (p as { status?: string }).status === "proposed"
    ).length,
    blockedCount: proposalsArr.filter(
      (p) => (p as { status?: string }).status === "blocked"
    ).length,
    staleCount: proposalsArr.filter(
      (p) => (p as { status?: string }).status === "stale"
    ).length,
    lastProcessedAt:
      typeof data.lastProcessedIso === "string"
        ? data.lastProcessedIso
        : toIsoString(data.lastProcessedAt),
    linesTruncated: Boolean(data.linesTruncated),
    lines: lines as StripePayoutView["lines"],
    exceptions: Array.isArray(data.exceptions)
      ? (data.exceptions as StripePayoutView["exceptions"])
      : [],
  };
}

// The accounting-automation section data: mode, recent payout ledgers,
// live proposals, and the reconciliation timestamp the workspace already
// tracks. Read-only — nothing here triggers provider calls beyond the
// QBO availability flag.
export async function getStripePayoutAutomationView(input: {
  environment?: QboEnvironment;
  lastReconAt?: string;
}): Promise<StripePayoutAutomationView> {
  const environment = input.environment ?? getQboEnvironment();
  const mode = getStripeAccountingMode();
  const cutover = getStripeAutomationCutover();

  const db = getFirebaseAdminDb();
  const [payoutsSnap, proposalsSnap] = await Promise.all([
    db
      .collection(STRIPE_PAYOUTS_COLLECTION)
      .where("environment", "==", environment)
      .orderBy("lastProcessedAt", "desc")
      .limit(PAYOUT_VIEW_LIMIT)
      .get(),
    proposalsCollection()
      .where("environment", "==", environment)
      .orderBy("computedAt", "desc")
      .limit(PROPOSAL_VIEW_LIMIT)
      .get(),
  ]);

  const proposalCountByPayout = new Map<string, number>();
  const proposalListByPayout = new Map<string, QboAccountingProposal[]>();
  const proposals: QboAccountingProposal[] = [];
  for (const doc of proposalsSnap.docs) {
    const data = doc.data() as QboAccountingProposal & {
      payoutId?: string;
    };
    proposals.push(data);
    if (data.payoutId) {
      proposalCountByPayout.set(
        data.payoutId,
        (proposalCountByPayout.get(data.payoutId) ?? 0) + 1
      );
      const list = proposalListByPayout.get(data.payoutId) ?? [];
      list.push(data);
      proposalListByPayout.set(data.payoutId, list);
    }
  }

  const payouts = payoutsSnap.docs.map((doc) => {
    const data = doc.data();
    return toPayoutView(doc.id, {
      ...data,
      proposalCount: proposalCountByPayout.get(doc.id) ?? 0,
      proposals: proposalListByPayout.get(doc.id) ?? [],
    });
  });
  // Stable presentation order: the Stripe payout's own arrival date,
  // newest first, with the payout id as a deterministic tie-breaker.
  // The query above pages by last-processed time — reprocessing or a
  // manual sync would otherwise reshuffle the dashboard on every pass.
  // Docs missing an arrival date sort last.
  payouts.sort((a, b) => {
    const dateCmp = (b.arrivalDate ?? "").localeCompare(
      a.arrivalDate ?? ""
    );
    return dateCmp !== 0 ? dateCmp : b.payoutId.localeCompare(a.payoutId);
  });

  return {
    configured: true,
    environment,
    mode,
    writesEnabled: mode !== "observe",
    cutover: cutover ?? undefined,
    lastReconAt: input.lastReconAt,
    payouts,
    proposals,
    qboAvailable: isQboConfigured(),
  };
}

// --- Scheduled recovery sweep + admin-triggered manual sync ---

// Single-run mutual exclusion for payout processing: the cron sweep and
// the admin manual sync share one environment-scoped lease doc so they
// can never interleave provider calls and ledger writes. The lease is a
// Firestore transaction with a short expiry — a crashed run releases
// automatically instead of stranding the lock. (The lease guards
// *overlap*; idempotency guards *correctness* — deterministic proposal
// ids and the up-to-date check make any replay converge regardless.)
const PAYOUT_SYNC_LOCK_LEASE_MS = 2 * 60 * 1000;

// Manual sync bounds: the scan paginates through the whole 35-day
// lookback (≤3 pages × 100) so a backlog larger than the sweep's
// single-page/5-per-day budget is still reachable, and up to 10 payouts
// are processed per click — anything left over is reported as
// `remaining` for the next run rather than processed unboundedly.
const PAYOUT_SYNC_SCAN_MAX_PAGES = 3;
const PAYOUT_SYNC_MAX_PROCESS = 10;
const PAYOUT_SYNC_RESULTS_LIMIT = 25;

const PAYOUT_ID_PATTERN = /^po_[A-Za-z0-9]+$/;

function payoutSyncLockRef(environment: QboEnvironment) {
  return getFirebaseAdminDb()
    .collection(QBO_SWEEP_STATE_COLLECTION)
    .doc(`stripePayoutSync-${environment}`);
}

// Every acquisition gets a unique owner token. Release and renewal are
// both conditional on that token, so a run that outlives its TTL — and
// watches another invocation legitimately acquire the expired lock —
// can neither clear the successor's lease nor keep working under it.
// The residual window is a single in-flight payout build after losing
// ownership; deterministic document/proposal ids make that overlap
// converge harmlessly.
async function acquirePayoutSyncLease(
  environment: QboEnvironment,
  nowMs: number
): Promise<string | null> {
  const ref = payoutSyncLockRef(environment);
  const owner = randomUUID();
  const acquired = await getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const leaseMs = timestampMillis(
      (snap.data() as { leaseUntil?: unknown } | undefined)?.leaseUntil
    );
    if (snap.exists && leaseMs !== null && leaseMs > nowMs) return false;
    tx.set(ref, {
      environment,
      owner,
      leaseUntil: Timestamp.fromMillis(nowMs + PAYOUT_SYNC_LOCK_LEASE_MS),
      lockedAtMs: nowMs,
    });
    return true;
  });
  return acquired ? owner : null;
}

// Extends the TTL only while `owner` still holds the lease — this doubles
// as the liveness check run before each payout: `false` means the lock
// expired and was reacquired, and the run must stop processing.
async function renewPayoutSyncLease(
  environment: QboEnvironment,
  owner: string,
  nowMs: number
): Promise<boolean> {
  const ref = payoutSyncLockRef(environment);
  return getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = snap.data() as {
      owner?: unknown;
      leaseUntil?: unknown;
    };
    const leaseMs = timestampMillis(data.leaseUntil);
    if (data.owner !== owner || leaseMs === null || leaseMs <= nowMs) {
      return false;
    }
    tx.set(
      ref,
      {
        leaseUntil: Timestamp.fromMillis(nowMs + PAYOUT_SYNC_LOCK_LEASE_MS),
        renewedAtMs: nowMs,
      },
      { merge: true }
    );
    return true;
  });
}

// Conditional release: only the current owner may free the lock. A slow
// first run finishing after reacquisition leaves the successor's lease
// untouched.
async function releasePayoutSyncLease(
  environment: QboEnvironment,
  owner: string
): Promise<void> {
  const ref = payoutSyncLockRef(environment);
  await getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data() as { owner?: unknown };
    if (data.owner !== owner) return;
    tx.set(
      ref,
      { leaseUntil: Timestamp.fromMillis(0), releasedAtMs: Date.now() },
      { merge: true }
    );
  });
}

// The up-to-date check every recovery path shares: the stored doc is
// current when it already reflects the canonical status, has no pending
// ledger build, and carries a completed processing timestamp.
function storedPayoutUpToDate(
  stored: Record<string, unknown> | undefined,
  payout: StripePayoutFacts
): boolean {
  return Boolean(
    stored &&
      stored.status === payout.status &&
      stored.pendingLedger !== true &&
      stored.pendingAutoApply !== true &&
      typeof stored.lastProcessedAt === "object"
  );
}

// Status-only persistence for payouts with nothing to reconcile
// (pending/in_transit/failed/canceled): the canonical fields are recorded
// without the balance-transaction fetch so coverage includes non-paid
// receipts too. Shared by the sweep and the manual sync — the paths must
// never diverge on what "recorded" means.
async function persistStripePayoutStatus(
  environment: QboEnvironment,
  payout: StripePayoutFacts
): Promise<void> {
  await payoutRef(payout.id).set(
    deepOmitUndefined({
      payoutId: payout.id,
      environment,
      status: payout.status,
      amountMinor: payout.amountMinor,
      currency: payout.currency,
      arrivalDate: payout.arrivalDate,
      method: payout.method,
      payoutType: payout.type,
      createdMs: payout.createdMs,
      pendingLedger: false,
      // A payout that fell out of `paid` has no executable proposals —
      // clear any outstanding automatic-apply retry flag with it.
      pendingAutoApply: false,
      lastProcessedAt: FieldValue.serverTimestamp(),
      lastProcessedIso: new Date().toISOString(),
    }),
    { merge: true }
  );
}

// The fallback for missed webhook deliveries: list recent payouts and
// process any whose ledger is missing, pending, or behind the canonical
// status. Bounded per run — a large backlog drains over successive days
// rather than one runaway invocation. Takes the shared sync lease so a
// manual admin sync and the sweep never overlap.
export async function runStripePayoutSweep(): Promise<{
  scanned: number;
  processed: number;
  skipped: number;
}> {
  if (!isStripeConfigured()) {
    return { scanned: 0, processed: 0, skipped: 0 };
  }
  const environment = getQboEnvironment();
  const owner = await acquirePayoutSyncLease(environment, Date.now());
  if (!owner) {
    logInfo("stripe.payout.sweep_skipped", {
      environment,
      reason: "sync_in_progress",
    });
    return { scanned: 0, processed: 0, skipped: 0 };
  }
  try {
    const cutoffSec =
      Math.floor(Date.now() / 1000) - PAYOUT_SWEEP_LOOKBACK_DAYS * 86_400;
    const { payouts: recent } = await listRecentStripePayouts({
      createdGteSec: cutoffSec,
      limit: 50,
    });
    let processed = 0;
    let skipped = 0;
    let leaseLost = false;
    for (const payout of recent) {
      if (leaseLost || processed >= PAYOUT_SWEEP_MAX_PROCESS) {
        skipped += 1;
        continue;
      }
      const snap = await payoutRef(payout.id).get();
      const stored = snap.exists ? snap.data() : undefined;
      if (storedPayoutUpToDate(stored, payout)) {
        skipped += 1;
        continue;
      }
      // Ownership check before each unit of work: if the TTL elapsed and
      // another invocation holds the lock, hand the backlog to it rather
      // than writing under its lease.
      if (!(await renewPayoutSyncLease(environment, owner, Date.now()))) {
        leaseLost = true;
        skipped += 1;
        logWarn("stripe.payout.sweep_lease_lost", {
          environment,
          payoutId: payout.id,
        });
        continue;
      }
      try {
        if (payout.status !== "paid") {
          await persistStripePayoutStatus(environment, payout);
        } else {
          await processStripePayoutLedger(payout.id);
        }
        processed += 1;
      } catch (error) {
        // One failing payout must not block recovery for the rest —
        // pendingLedger stays set, so the next sweep retries it.
        logError("stripe.payout.sweep_item_failed", error, {
          payoutId: payout.id,
        });
        skipped += 1;
      }
    }
    logInfo("stripe.payout.sweep", {
      scanned: recent.length,
      processed,
      skipped,
      leaseLost,
    });
    return { scanned: recent.length, processed, skipped };
  } finally {
    await releasePayoutSyncLease(environment, owner).catch((error) =>
      logError("stripe.payout.sync_lease_release_failed", error, {
        environment,
      })
    );
  }
}

function emptySyncSummary(
  environment: QboEnvironment,
  scope: StripePayoutSyncSummary["scope"]
): StripePayoutSyncSummary {
  return {
    environment,
    scope,
    discovered: 0,
    processed: 0,
    statusRecorded: 0,
    alreadyCurrent: 0,
    failed: 0,
    remaining: 0,
    scanTruncated: false,
    cutover: getStripeAutomationCutover() ?? undefined,
    items: [],
  };
}

function pushSyncItem(
  summary: StripePayoutSyncSummary,
  item: StripePayoutSyncItem
): void {
  if (summary.items.length < PAYOUT_SYNC_RESULTS_LIMIT) {
    summary.items.push(item);
  }
}

// Single-payout sync: fetch the canonical payout, verify it belongs to
// this Stripe environment (the configured key already scopes account +
// mode — a foreign id simply does not resolve — and `livemode` is the
// explicit cross-check), then run the same processing the sweep applies.
async function syncSingleStripePayout(
  environment: QboEnvironment,
  payoutId: string,
  owner: string
): Promise<StripePayoutSyncSummary> {
  const summary = emptySyncSummary(environment, "single");
  summary.discovered = 1;
  const item: StripePayoutSyncItem = {
    payoutId,
    status: "unknown",
    outcome: "failed",
  };
  try {
    const payout = await fetchStripePayout(payoutId);
    const modeMismatch =
      payout &&
      payout.livemode !== undefined &&
      payout.livemode === isStripeTestMode();
    if (!payout || modeMismatch) {
      item.outcome = "not_found";
      summary.failed += 1;
    } else if (
      !(await renewPayoutSyncLease(environment, owner, Date.now()))
    ) {
      // Lease lost mid-run — another invocation owns the lock now. Not a
      // processing failure: the payout is untouched and retryable once
      // the lock frees.
      item.status = payout.status;
      item.outcome = "lease_lost";
      summary.remaining += 1;
      logWarn("stripe.payout.sync_lease_lost", { environment, payoutId });
    } else {
      item.status = payout.status;
      if (payout.status !== "paid") {
        await persistStripePayoutStatus(environment, payout);
        item.outcome = "status_recorded";
        summary.statusRecorded += 1;
      } else {
        const result = await processStripePayoutLedger(payout.id);
        if (!result) {
          summary.failed += 1;
        } else {
          item.outcome = "processed";
          item.proposals = result.proposalCount;
          item.eligibleLines = result.eligibleLineCount;
          item.preCutoverLines = result.preCutoverLineCount;
          summary.processed += 1;
        }
      }
    }
  } catch (error) {
    summary.failed += 1;
    logError("stripe.payout.sync_item_failed", error, { payoutId });
  }
  pushSyncItem(summary, item);
  return summary;
}

// Recent-payout sync: the manual counterpart of the daily sweep over the
// same 35-day lookback. Paginates the bounded Stripe scan (the sweep's
// single page can leave a deep backlog unreachable), then applies the
// sweep's exact per-payout rules — up-to-date check, status-only record
// for non-paid, canonical ledger build for paid. Per-payout failures are
// isolated and counted; the Stripe list failure itself is not (an
// unreachable provider is a failed sync, not a partial one).
async function syncRecentStripePayouts(
  environment: QboEnvironment,
  owner: string
): Promise<StripePayoutSyncSummary> {
  const summary = emptySyncSummary(environment, "recent");
  const cutoffSec =
    Math.floor(Date.now() / 1000) - PAYOUT_SWEEP_LOOKBACK_DAYS * 86_400;
  const { payouts, truncated } = await listRecentStripePayouts({
    createdGteSec: cutoffSec,
    limit: 100,
    maxPages: PAYOUT_SYNC_SCAN_MAX_PAGES,
  });
  summary.discovered = payouts.length;
  summary.scanTruncated = truncated;

  let worked = 0;
  let leaseLost = false;
  for (const payout of payouts) {
    const snap = await payoutRef(payout.id).get();
    const stored = snap.exists ? snap.data() : undefined;
    const item: StripePayoutSyncItem = {
      payoutId: payout.id,
      status: payout.status,
      outcome: "failed",
    };
    if (storedPayoutUpToDate(stored, payout)) {
      summary.alreadyCurrent += 1;
      continue;
    }
    if (leaseLost || worked >= PAYOUT_SYNC_MAX_PROCESS) {
      summary.remaining += 1;
      continue;
    }
    // Renewal doubles as the ownership check: once the TTL has elapsed
    // and a successor holds the lock, the rest of the backlog belongs to
    // that run — report it as remaining instead of working under a lease
    // this invocation no longer owns.
    if (!(await renewPayoutSyncLease(environment, owner, Date.now()))) {
      leaseLost = true;
      summary.remaining += 1;
      logWarn("stripe.payout.sync_lease_lost", {
        environment,
        payoutId: payout.id,
      });
      continue;
    }
    worked += 1;
    try {
      if (payout.status !== "paid") {
        await persistStripePayoutStatus(environment, payout);
        item.outcome = "status_recorded";
        summary.statusRecorded += 1;
      } else {
        const result = await processStripePayoutLedger(payout.id);
        if (!result) {
          summary.failed += 1;
        } else {
          item.outcome = "processed";
          item.proposals = result.proposalCount;
          item.eligibleLines = result.eligibleLineCount;
          item.preCutoverLines = result.preCutoverLineCount;
          summary.processed += 1;
        }
      }
    } catch (error) {
      summary.failed += 1;
      logError("stripe.payout.sync_item_failed", error, {
        payoutId: payout.id,
      });
    }
    pushSyncItem(summary, item);
  }
  return summary;
}

// Admin-triggered payout synchronization (`Sync recent payouts`, or a
// single payout id for targeted recovery). Runs under the shared sync
// lease so overlapping invocations — double-clicked buttons, concurrent
// admins, a simultaneous cron sweep — can never interleave; a second
// caller gets a 409 instead of a duplicated run. Everything past the
// lease is the existing recovery pipeline: same lookback, same canonical
// fetches, same idempotent persistence, same cutover and decided-status
// preservation — nothing here posts to QuickBooks.
export async function syncStripePayouts(input: {
  payoutId?: string;
} = {}): Promise<StripePayoutSyncSummary> {
  if (!isStripeConfigured()) {
    throw new QboError(
      "Stripe is not configured on this deployment.",
      "configuration"
    );
  }
  const payoutId = input.payoutId?.trim();
  if (payoutId && !PAYOUT_ID_PATTERN.test(payoutId)) {
    throw new QboError(
      "A payoutId must be a Stripe payout id (po_…).",
      "validation",
      400
    );
  }
  const environment = getQboEnvironment();
  const owner = await acquirePayoutSyncLease(environment, Date.now());
  if (!owner) {
    throw new QboError(
      "A payout sync is already running — try again shortly.",
      "validation",
      409
    );
  }
  try {
    const summary = payoutId
      ? await syncSingleStripePayout(environment, payoutId, owner)
      : await syncRecentStripePayouts(environment, owner);
    logInfo("stripe.payout.sync", {
      environment,
      scope: summary.scope,
      discovered: summary.discovered,
      processed: summary.processed,
      statusRecorded: summary.statusRecorded,
      alreadyCurrent: summary.alreadyCurrent,
      failed: summary.failed,
      remaining: summary.remaining,
      scanTruncated: summary.scanTruncated,
    });
    return summary;
  } finally {
    await releasePayoutSyncLease(environment, owner).catch((error) =>
      logError("stripe.payout.sync_lease_release_failed", error, {
        environment,
      })
    );
  }
}
