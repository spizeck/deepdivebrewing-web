import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { deepOmitUndefined } from "@/lib/firestore-safe";
import { getQboEnvironment, isQboConfigured } from "@/lib/qbo-config";
import { logError } from "@/lib/log";
import {
  timestampMillis,
  PAYMENTS_COLLECTION,
} from "@/lib/payments-common";
import { getQuickBooksAccessToken } from "@/lib/qbo-tokens";
import { getQboMappingView } from "@/lib/qbo-mapping";
import {
  fetchQboAccountBalance,
  queryQboReconActivity,
} from "@/lib/qbo-api";
import { QBO_RECON_ACTIVITY_ENTITIES } from "@/lib/qbo-protocol";
import {
  fetchStripeBalanceTotals,
  fetchStripeChargeFacts,
  fetchStripeRefundFacts,
  listStripeBalanceTransactions,
} from "@/lib/stripe-balance";
import {
  buildDdbPaymentScan,
  buildReconFindings,
  classifyStripeBalanceTxn,
  dedupeBalanceTxns,
  gateQboLedgerAmounts,
  resolveChargeAttribution,
  resolveQboReconRange,
  resolveRefundAttribution,
  QBO_RECON_STATE_COLLECTION,
  type ClassifiedBalanceTxn,
  type DdbReconPaymentFacts,
  type DdbStripeIdentity,
  type QboReconLedgerItem,
  type QboReconRange,
  type QboReconRunView,
  type ReconMatchResolution,
  type StripeBalanceTxnFacts,
} from "@/lib/qbo-recon-common";
import {
  abbreviateRealmId,
  type QboEnvironment,
} from "@/lib/qbo-common";
import { QboError } from "@/lib/qbo-errors";
import type { AdminActor } from "@/lib/admin-auth";

// Reconciliation orchestration (issue #181): assembles the read-only
// Stripe ⇄ QuickBooks report the accountant reviews. It reads Stripe
// balance state, the app's canonical `payments` records, the QBO
// clearing-account ledger, and any existing QBO entries touching the
// watched accounts — then *reports*. It posts nothing to QuickBooks,
// creates no deposits or journal entries, and never touches the Ollie
// lane's accounting. The only write is the `qboReconState` snapshot of
// the run itself so the next report can roll forward from a known
// clearing balance.

// Provider-side enrichment (charge/refund retrieves) is the most
// expensive part of a run — bounded so an admin click can never turn
// into an unbounded Stripe scan. Remaining unattributed rows surface in
// the report rather than being guessed.
const ENRICHMENT_BUDGET = 40;
// In-range `payments` documents scanned per run.
const PAYMENTS_SCAN_LIMIT = 2000;
// Flags carried into the stored report — the Firestore snapshot stays
// small; the full run is reconstructable by re-running the window.
const FLAG_LIMIT = 200;
// Ledger items carried into the report list.
const LEDGER_ITEM_LIMIT = 100;

interface PaymentsScan {
  identity: DdbStripeIdentity;
  facts: DdbReconPaymentFacts[];
  truncated: boolean;
}

// Canonical `payments` records tied to the window — the positive
// identity for attribution and the cross-check set for missing/
// mismatched movements. Two scans merge by document id: payments paid
// inside the window, and payments refunded inside the window. The
// second scan is what lets an in-window refund of an earlier payment
// attribute to the DDB lane instead of reading as external. Cash
// payments never touch Stripe: they contribute no identity and expect
// no balance transactions.
async function scanPaymentsInRange(range: QboReconRange): Promise<PaymentsScan> {
  const db = getFirebaseAdminDb();
  const [paidSnap, refundedSnap] = await Promise.all([
    db
      .collection(PAYMENTS_COLLECTION)
      .where("paidAt", ">=", Timestamp.fromMillis(range.fromMs))
      .where("paidAt", "<", Timestamp.fromMillis(range.toMsExclusive))
      .limit(PAYMENTS_SCAN_LIMIT)
      .get(),
    db
      .collection(PAYMENTS_COLLECTION)
      .where("refundedAt", ">=", Timestamp.fromMillis(range.fromMs))
      .where("refundedAt", "<", Timestamp.fromMillis(range.toMsExclusive))
      .limit(PAYMENTS_SCAN_LIMIT)
      .get(),
  ]);

  // A payment paid AND refunded inside the window appears in both result
  // sets — merge by document id so it is scanned once.
  const docs = new Map(paidSnap.docs.map((doc) => [doc.id, doc]));
  for (const doc of refundedSnap.docs) {
    docs.set(doc.id, doc);
  }

  const stringField = (value: unknown) =>
    typeof value === "string" && value ? value : undefined;
  const records = [...docs.values()].map((doc) => {
    const payment = doc.data();
    return {
      paymentId: doc.id,
      status: payment.status,
      paymentMethod: payment.paymentMethod,
      paidAtMs: timestampMillis(payment.paidAt),
      refundedAtMs: timestampMillis(payment.refundedAt),
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      chargeId: stringField(payment.stripeChargeId),
      paymentIntentId: stringField(payment.stripePaymentIntentId),
      refundId: stringField(payment.stripeRefundId),
    };
  });
  const { identity, facts } = buildDdbPaymentScan(records, range);

  return {
    identity,
    facts,
    truncated:
      paidSnap.size >= PAYMENTS_SCAN_LIMIT ||
      refundedSnap.size >= PAYMENTS_SCAN_LIMIT,
  };
}

// Second-pass attribution: unresolved charge/refund sources get one
// bounded provider lookup each (owning PaymentIntent / charge metadata —
// the app writes `metadata.paymentId` at session creation). Anything the
// budget skips stays unattributed in the report. Charges resolved
// through their PaymentIntent are handed back so the cross-check can
// match a payment that never recorded a charge id.
async function enrichUnattributed(
  classified: ClassifiedBalanceTxn[],
  identity: DdbStripeIdentity
): Promise<{ resolution: ReconMatchResolution; truncated: boolean }> {
  const paymentIds = new Set<string>();
  const chargesByIntentId = new Map<string, StripeBalanceTxnFacts>();
  let budget = ENRICHMENT_BUDGET;
  let truncated = false;

  for (const item of classified) {
    if (!item.resolvable || item.attribution !== "unattributed") continue;
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const source = item.txn.source;
    if (!source) continue;
    budget -= 1;
    try {
      if (item.bucket === "charge") {
        const facts = await fetchStripeChargeFacts(source);
        item.attribution = resolveChargeAttribution(facts, identity);
        if (item.attribution === "ddb") {
          if (facts.paymentId) paymentIds.add(facts.paymentId);
          if (facts.paymentIntentId) {
            chargesByIntentId.set(facts.paymentIntentId, item.txn);
          }
        }
      } else if (item.bucket === "refund") {
        const facts = await fetchStripeRefundFacts(source);
        item.attribution = resolveRefundAttribution(facts, identity);
        if (item.attribution === "ddb" && facts.paymentId) {
          paymentIds.add(facts.paymentId);
        }
      }
      item.resolvable = false;
    } catch {
      // A failed enrichment read leaves the row unattributed — the flag
      // tells the operator to inspect it in the Stripe dashboard. A
      // provider hiccup must not sink the whole report.
    }
  }
  return { resolution: { paymentIds, chargesByIntentId }, truncated };
}

interface QboLeg {
  clearingBalanceMinor?: number;
  clearingCurrency?: string;
  clearingAccountId?: string;
  clearingName?: string;
  feeBalanceMinor?: number;
  feeCurrency?: string;
  feeAccountId?: string;
  clearingActivityMinor?: number;
  ledgerItems: QboReconLedgerItem[];
  truncated: boolean;
  available: boolean;
  realmId?: string;
}

// The QuickBooks side of the ledger: balances of the watched accounts
// plus the in-range entries that already touch them — bank-feed
// adjustments, expense entries, and clearing transfers. This is the
// "are fees already booked somewhere?" evidence the owner asked for
// before any fee entry is proposed. Best-effort: a missing grant or a
// revoked token degrades this leg to `available: false`; the Stripe
// half of the report still stands.
async function fetchQboLeg(
  environment: QboEnvironment,
  range: QboReconRange
): Promise<QboLeg> {
  const empty: QboLeg = {
    ledgerItems: [],
    truncated: false,
    available: false,
  };
  if (!isQboConfigured()) return empty;
  try {
    const [mappingView, token] = await Promise.all([
      getQboMappingView(),
      getQuickBooksAccessToken(),
    ]);
    const clearingId = mappingView.mapping?.stripeClearingAccountId;
    const feeId = mappingView.mapping?.stripeFeeExpenseAccountId;
    const watched = new Set(
      [clearingId, feeId].filter((id): id is string => Boolean(id))
    );

    const [clearing, fee] = await Promise.all([
      clearingId
        ? fetchQboAccountBalance({ ...token, environment, accountId: clearingId })
        : Promise.resolve(null),
      feeId
        ? fetchQboAccountBalance({ ...token, environment, accountId: feeId })
        : Promise.resolve(null),
    ]);

    const ledgerItems: QboReconLedgerItem[] = [];
    let clearingActivityMinor = 0;
    let truncated = false;
    if (watched.size) {
      const scans = await Promise.all(
        QBO_RECON_ACTIVITY_ENTITIES.map((entity) =>
          queryQboReconActivity({
            ...token,
            environment,
            entity,
            fromDate: range.from,
            toDate: range.to,
          })
        )
      );
      for (const scan of scans) {
        truncated ||= scan.truncated;
        for (const entry of scan.rows) {
          const hits = entry.legs.filter((leg) => watched.has(leg.accountId));
          if (!hits.length) continue;
          for (const leg of entry.legs) {
            if (leg.accountId === clearingId) {
              clearingActivityMinor += leg.amountMinor;
            }
          }
          ledgerItems.push({
            entityType: entry.entityType,
            id: entry.id,
            txnDate: entry.txnDate,
            docNumber: entry.docNumber,
            memo: entry.memo,
            amountMinor: hits.reduce((sum, leg) => sum + leg.amountMinor, 0),
            accountIds: hits.map((leg) => leg.accountId),
          });
        }
      }
      ledgerItems.sort((a, b) =>
        (a.txnDate ?? "") < (b.txnDate ?? "") ? -1 : 1
      );
    }

    return {
      clearingBalanceMinor: clearing?.balanceMinor,
      clearingCurrency: clearing?.currency,
      clearingAccountId: clearingId,
      clearingName: clearing?.name,
      feeBalanceMinor: fee?.balanceMinor,
      feeCurrency: fee?.currency,
      feeAccountId: feeId,
      clearingActivityMinor: clearingId ? clearingActivityMinor : undefined,
      ledgerItems: ledgerItems.slice(0, LEDGER_ITEM_LIMIT),
      truncated: truncated || ledgerItems.length > LEDGER_ITEM_LIMIT,
      available: true,
      realmId: token.realmId,
    };
  } catch (error) {
    // Not configured / not connected / grant expired are ordinary states
    // for a report — the QBO leg simply reports unavailable. Provider
    // failures get logged so an ops trace exists.
    const quiet =
      error instanceof QboError &&
      (error.kind === "configuration" ||
        error.kind === "validation" ||
        error.kind === "authorization_expired");
    if (!quiet) {
      logError("qbo.recon.qbo_leg_failed", error, { environment });
    }
    return empty;
  }
}

function stateRef(environment: QboEnvironment) {
  return getFirebaseAdminDb()
    .collection(QBO_RECON_STATE_COLLECTION)
    .doc(environment);
}

// The latest persisted run — the admin surface's initial view and the
// roll-forward baseline (`previousClearingBalanceMinor`) for the next
// run. Returns null when no run has ever completed.
export async function getQboReconLatest(
  environment?: QboEnvironment
): Promise<QboReconRunView | null> {
  const env = environment ?? getQboEnvironment();
  const snap = await stateRef(env).get();
  const view = snap.data()?.view;
  if (!view || typeof view !== "object") return null;
  return view as QboReconRunView;
}

// Runs one bounded reconciliation and persists the snapshot. Everything
// here is read-only against both providers; the stored document is the
// report itself, not accounting data.
export async function runQboReconciliation(input: {
  actor: AdminActor;
  from?: string;
  to?: string;
}): Promise<QboReconRunView> {
  const environment = getQboEnvironment();
  const resolved = resolveQboReconRange({ from: input.from, to: input.to });
  if (!resolved.ok) {
    throw new QboError(resolved.error, "validation", 400);
  }
  const range = resolved.range;
  const currency = "USD";

  const [stripe, scan, previous] = await Promise.all([
    Promise.all([
      listStripeBalanceTransactions({
        createdGteSec: Math.floor(range.fromMs / 1000),
        createdLtSec: Math.floor(range.toMsExclusive / 1000),
      }),
      fetchStripeBalanceTotals("usd"),
    ]),
    scanPaymentsInRange(range),
    getQboReconLatest(environment).catch(() => null),
  ]);
  const [{ txns, truncated: stripeTruncated }, balance] = stripe;

  const classified = dedupeBalanceTxns(txns).map((txn) =>
    classifyStripeBalanceTxn(txn, scan.identity)
  );
  const enrichment = await enrichUnattributed(classified, scan.identity);
  const { totals, flags } = buildReconFindings(
    classified,
    scan.facts,
    enrichment.resolution,
    currency
  );

  const qbo = await fetchQboLeg(environment, range);

  // The clearing difference and ledger items only mean something when
  // the mapped accounts' currencies match the run currency — a foreign
  // balance subtracted from the USD Stripe balance, or legs summed into
  // a USD-formatted ledger item, would silently corrupt the comparison.
  // Mismatches are flagged and their amounts suppressed, never
  // converted.
  const ledger = gateQboLedgerAmounts({
    runCurrency: currency,
    stripeAvailableMinor: balance.availableMinor,
    clearingAccountId: qbo.clearingAccountId,
    clearingCurrency: qbo.clearingCurrency,
    clearingBalanceMinor: qbo.clearingBalanceMinor,
    clearingActivityMinor: qbo.clearingActivityMinor,
    feeAccountId: qbo.feeAccountId,
    feeCurrency: qbo.feeCurrency,
    feeBalanceMinor: qbo.feeBalanceMinor,
    ledgerItems: qbo.ledgerItems,
  });
  flags.push(...ledger.flags);

  const netMovementMinor = totals.availableNetMinor + totals.pendingNetMinor;

  const view: QboReconRunView = {
    environment,
    realmIdShort: qbo.realmId ? abbreviateRealmId(qbo.realmId) : undefined,
    ranAt: new Date().toISOString(),
    ranByEmail: input.actor.token.email ?? input.actor.record.email,
    range: { from: range.from, to: range.to },
    currency,
    stripeAvailableMinor: balance.availableMinor,
    stripePendingMinor: balance.pendingMinor,
    qboClearingBalanceMinor: ledger.qboClearingBalanceMinor,
    clearingDifferenceMinor: ledger.clearingDifferenceMinor,
    qboFeeBalanceMinor: ledger.qboFeeBalanceMinor,
    qboLedgerItems: ledger.qboLedgerItems,
    qboClearingActivityMinor: ledger.qboClearingActivityMinor,
    qboActivityTruncated: qbo.truncated,
    previousClearingBalanceMinor:
      previous?.qboClearingBalanceMinor,
    netMovementMinor,
    totals,
    flags: flags.slice(0, FLAG_LIMIT),
    flagsTruncated: flags.length > FLAG_LIMIT,
    stripeScanTruncated: stripeTruncated,
    paymentsScanTruncated: scan.truncated,
    enrichmentTruncated: enrichment.truncated,
    qboAvailable: qbo.available,
  };

  // Firestore rejects `undefined` anywhere in the payload — the view and
  // this envelope carry legitimately-optional fields (ledger DocNumber /
  // memo, unmapped-account balances, actor email) that arrive undefined.
  // deepOmitUndefined turns them into absent keys; FieldValue sentinels
  // pass through untouched.
  await stateRef(environment).set(
    deepOmitUndefined({
      environment,
      view,
      ranAt: FieldValue.serverTimestamp(),
      ranByUid: input.actor.token.uid,
      ranByEmail: input.actor.token.email ?? input.actor.record.email,
    }),
    { merge: false }
  );
  return view;
}
