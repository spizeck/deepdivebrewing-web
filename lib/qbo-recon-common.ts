// Shared, dependency-free vocabulary and pure logic for the Stripe
// clearing-account reconciliation report (issue #181). Firebase-free so
// admin client components may import the view types; all provider IO and
// persistence lives in the server-only modules (lib/stripe-balance.ts,
// lib/qbo-recon.ts).
//
// Reconciliation is strictly read-only: it compares authoritative Stripe
// Balance Transactions against the app's own verified payment records and
// the QBO clearing-account ledger balance, then *reports* — it never posts,
// adjusts, or "fixes" anything. Attribution is positive-identity only: a
// Stripe movement is DDB-owned only when a canonical `payments` record's
// application-issued identifiers (charge id, PaymentIntent id, refund id,
// or the `metadata.paymentId` the tool itself wrote) prove it. Everything
// else is external (the Ollie/Spreedly lane and any other account activity)
// or unattributed when it could not be resolved inside the bounded scan.

import type { QboEnvironment } from "@/lib/qbo-common";

// Latest completed run — one document per environment, overwritten on each
// run. Deny-all to Firebase clients like every qbo* collection.
export const QBO_RECON_STATE_COLLECTION = "qboReconState";

// --- Range ---

export const QBO_RECON_DEFAULT_RANGE_DAYS = 30;
export const QBO_RECON_MAX_RANGE_DAYS = 180;

const RECON_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface QboReconRange {
  /** Inclusive YYYY-MM-DD bounds (UTC). */
  from: string;
  to: string;
  /** Epoch ms at `from` 00:00 UTC — Stripe `created.gte` / Firestore `>=`. */
  fromMs: number;
  /** Epoch ms at `to`+1 00:00 UTC — Stripe `created.lt` / Firestore `<`. */
  toMsExclusive: number;
}

export type QboReconRangeResult =
  | { ok: true; range: QboReconRange }
  | { ok: false; error: string };

function dayMs(day: string): number | null {
  if (!RECON_DATE_PATTERN.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return null;
  // Date.parse normalizes out-of-range components (e.g. 2026-02-31 → Mar 3);
  // require a round-trip so nonsense input is rejected instead of silently
  // reconciling a different window than the admin asked for.
  return new Date(ms).toISOString().slice(0, 10) === day ? ms : null;
}

// Validates the admin-supplied range (or supplies the trailing-30-day
// default). Bounds are calendar days UTC; `to` may not be in the future and
// the span is capped so a run stays inside the bounded Stripe scan.
export function resolveQboReconRange(
  input: { from?: unknown; to?: unknown },
  nowMs: number = Date.now()
): QboReconRangeResult {
  const provided = input.from != null || input.to != null;
  if (!provided) {
    const toMs = dayMs(new Date(nowMs).toISOString().slice(0, 10))!;
    const fromMs = toMs - (QBO_RECON_DEFAULT_RANGE_DAYS - 1) * 86_400_000;
    const from = new Date(fromMs).toISOString().slice(0, 10);
    const to = new Date(toMs).toISOString().slice(0, 10);
    return {
      ok: true,
      range: { from, to, fromMs, toMsExclusive: toMs + 86_400_000 },
    };
  }
  const from = typeof input.from === "string" ? input.from.trim() : "";
  const to = typeof input.to === "string" ? input.to.trim() : "";
  const fromMs = dayMs(from);
  const toMs = dayMs(to);
  if (fromMs === null || toMs === null) {
    return {
      ok: false,
      error: "Reconciliation dates must be valid YYYY-MM-DD calendar days.",
    };
  }
  if (fromMs > toMs) {
    return { ok: false, error: "The 'from' date must be on or before 'to'." };
  }
  const spanDays = Math.round((toMs - fromMs) / 86_400_000) + 1;
  if (spanDays > QBO_RECON_MAX_RANGE_DAYS) {
    return {
      ok: false,
      error: `Reconciliation is limited to ${QBO_RECON_MAX_RANGE_DAYS} days per run.`,
    };
  }
  const todayMs = dayMs(new Date(nowMs).toISOString().slice(0, 10))!;
  if (toMs > todayMs) {
    return { ok: false, error: "The 'to' date cannot be in the future." };
  }
  return {
    ok: true,
    range: { from, to, fromMs, toMsExclusive: toMs + 86_400_000 },
  };
}

// --- Canonical Stripe balance-transaction facts ---

// The safe subset of a Stripe Balance Transaction the report uses — raw
// provider objects never cross lib/stripe-balance.ts. Amounts are signed
// integer minor units exactly as Stripe reports them (charge/refund `amount`
// is gross; `fee`/`net` are Stripe's own authoritative figures — never
// derived from fee schedules).
export interface StripeBalanceTxnFacts {
  id: string;
  /** Stripe's balance-transaction type (charge, refund, payout, …). */
  type: string;
  amountMinor: number;
  feeMinor: number;
  netMinor: number;
  /** Uppercase ISO-4217. */
  currency: string;
  /** Stripe's funds-availability status (available / pending). */
  status: string;
  /** Originating Stripe object id (ch_…, re_…, po_…, …). */
  source?: string;
  createdMs?: number;
  availableOnMs?: number;
}

// Duplicate prevention on the read side: provider pagination and any
// future merge of fetches must never count one balance transaction
// twice. Identity is the provider transaction id — the first occurrence
// wins and every later sighting is dropped.
export function dedupeBalanceTxns(
  txns: StripeBalanceTxnFacts[]
): StripeBalanceTxnFacts[] {
  const seen = new Set<string>();
  const out: StripeBalanceTxnFacts[] = [];
  for (const txn of txns) {
    if (seen.has(txn.id)) continue;
    seen.add(txn.id);
    out.push(txn);
  }
  return out;
}

export type QboReconBucket = "charge" | "refund" | "payout" | "other";

// Report bucket for a balance-transaction type. Both generations of Stripe
// naming are mapped (charge/payment, refund/payment_refund). Payouts and
// account-level movements (adjustments, transfers, Stripe's own fees) are
// never lane-attributed — a shared Stripe account's payouts mix both lanes.
export function qboReconBucketForType(type: string): QboReconBucket {
  switch (type) {
    case "charge":
    case "payment":
      return "charge";
    case "refund":
    case "payment_refund":
      return "refund";
    case "payout":
    case "payout_cancel":
    case "payout_failure":
      return "payout";
    default:
      return "other";
  }
}

// --- DDB identity + classification ---

// Verified application-issued identifiers collected from the canonical
// `payments` collection — the positive-identity set. A Stripe object is
// DDB-owned only through these; absence never implies DDB ownership.
export interface DdbStripeIdentity {
  chargeIds: ReadonlySet<string>;
  paymentIntentIds: ReadonlySet<string>;
  refundIds: ReadonlySet<string>;
  /** Internal payment ids — matched via `metadata.paymentId` on enriched
   *  Stripe objects. */
  paymentIds: ReadonlySet<string>;
}

export type QboReconAttribution = "ddb" | "external" | "unattributed";

export interface ClassifiedBalanceTxn {
  txn: StripeBalanceTxnFacts;
  bucket: QboReconBucket;
  /** Lane attribution for charge/refund buckets; payouts and other
   *  movements are account-level and carry no lane. */
  attribution: QboReconAttribution | "account_level";
  /** A provider-side lookup (charge/refund retrieve) could still resolve
   *  ownership — consumes the run's bounded enrichment budget. */
  resolvable: boolean;
}

// First-pass attribution from stored identifiers alone — no provider calls.
// `ch_`/`re_`-family sources that don't match a stored id stay
// `unattributed` + resolvable so the bounded enrichment pass can check the
// owning object's PaymentIntent/metadata instead of guessing.
export function classifyStripeBalanceTxn(
  txn: StripeBalanceTxnFacts,
  identity: DdbStripeIdentity
): ClassifiedBalanceTxn {
  const bucket = qboReconBucketForType(txn.type);
  const source = txn.source ?? "";
  if (bucket === "charge") {
    if (identity.chargeIds.has(source) || identity.paymentIntentIds.has(source)) {
      return { txn, bucket, attribution: "ddb", resolvable: false };
    }
    if (/^(ch_|py_)/.test(source)) {
      return { txn, bucket, attribution: "unattributed", resolvable: true };
    }
    return { txn, bucket, attribution: "external", resolvable: false };
  }
  if (bucket === "refund") {
    if (identity.refundIds.has(source)) {
      return { txn, bucket, attribution: "ddb", resolvable: false };
    }
    if (/^(re_|pyr_)/.test(source)) {
      return { txn, bucket, attribution: "unattributed", resolvable: true };
    }
    return { txn, bucket, attribution: "external", resolvable: false };
  }
  return { txn, bucket, attribution: "account_level", resolvable: false };
}

// Enrichment resolution for a retrieved charge: DDB only when the charge's
// PaymentIntent or embedded `metadata.paymentId` proves application
// identity — never on amount/date resemblance.
export function resolveChargeAttribution(
  facts: { paymentIntentId?: string; paymentId?: string },
  identity: DdbStripeIdentity
): QboReconAttribution {
  if (facts.paymentIntentId && identity.paymentIntentIds.has(facts.paymentIntentId)) {
    return "ddb";
  }
  if (facts.paymentId && identity.paymentIds.has(facts.paymentId)) {
    return "ddb";
  }
  return "external";
}

// Enrichment resolution for a retrieved refund: DDB when its owning charge
// (or, when present, its own metadata) resolves to the app's records.
export function resolveRefundAttribution(
  facts: { chargeId?: string; paymentIntentId?: string; paymentId?: string },
  identity: DdbStripeIdentity
): QboReconAttribution {
  if (facts.chargeId && identity.chargeIds.has(facts.chargeId)) {
    return "ddb";
  }
  return resolveChargeAttribution(facts, identity);
}

// --- Aggregation ---

// All amounts are integer minor units in the run's single reported
// currency. `feeMinor`/`refundMinor` magnitudes are reported positive for
// readability; `netMinor` keeps Stripe's sign convention (payouts and
// refunds are negative movements).
export interface QboReconTotals {
  txnCount: number;
  chargeCountDdb: number;
  grossChargesDdbMinor: number;
  feesDdbMinor: number;
  refundCountDdb: number;
  refundsDdbMinor: number;
  netDdbMinor: number;
  chargeCountExternal: number;
  grossChargesExternalMinor: number;
  feesExternalMinor: number;
  refundCountExternal: number;
  refundsExternalMinor: number;
  netExternalMinor: number;
  unattributedCount: number;
  unattributedGrossMinor: number;
  payoutCount: number;
  payoutNetMinor: number;
  otherCount: number;
  otherNetMinor: number;
  /** Net in-range movement by Stripe availability status. */
  availableNetMinor: number;
  pendingNetMinor: number;
}

// A report finding — never a mutation. `ref` is a safe identifier (Stripe
// object id or internal payment id), never PII or credential material.
export type QboReconFlagKind =
  | "unattributed_charge"
  | "unattributed_refund"
  | "missing_charge"
  | "missing_refund"
  | "amount_mismatch"
  | "currency_mismatch";

export interface QboReconFlag {
  kind: QboReconFlagKind;
  ref: string;
  detail: string;
  amountMinor?: number;
}

// Per-payment facts the cross-check needs — card rails only; cash payments
// never touch Stripe.
export interface DdbReconPaymentFacts {
  paymentId: string;
  amountMinor: number;
  currency: string;
  chargeId?: string;
  paymentIntentId?: string;
  refundId?: string;
  /** Card payments expected to appear as charge transactions in range. */
  expectsCharge: boolean;
  /** Refund expected in range (refundedAt within the window). */
  expectsRefund: boolean;
}

// Aggregates classified transactions and cross-checks the DDB payment
// records that should have produced in-range movements. `matchedPaymentIds`
// carries the ids enrichment already resolved — a payment matched there
// (or through any classified charge source) is never flagged missing.
export function buildReconFindings(
  classified: ClassifiedBalanceTxn[],
  payments: DdbReconPaymentFacts[],
  matchedPaymentIds: ReadonlySet<string>,
  runCurrency: string
): { totals: QboReconTotals; flags: QboReconFlag[] } {
  const totals: QboReconTotals = {
    txnCount: classified.length,
    chargeCountDdb: 0,
    grossChargesDdbMinor: 0,
    feesDdbMinor: 0,
    refundCountDdb: 0,
    refundsDdbMinor: 0,
    netDdbMinor: 0,
    chargeCountExternal: 0,
    grossChargesExternalMinor: 0,
    feesExternalMinor: 0,
    refundCountExternal: 0,
    refundsExternalMinor: 0,
    netExternalMinor: 0,
    unattributedCount: 0,
    unattributedGrossMinor: 0,
    payoutCount: 0,
    payoutNetMinor: 0,
    otherCount: 0,
    otherNetMinor: 0,
    availableNetMinor: 0,
    pendingNetMinor: 0,
  };
  const flags: QboReconFlag[] = [];
  const matchedSources = new Set<string>();
  const chargeAmountBySource = new Map<string, StripeBalanceTxnFacts>();

  for (const item of classified) {
    const { txn, bucket, attribution } = item;
    if (txn.currency !== runCurrency) {
      flags.push({
        kind: "currency_mismatch",
        ref: txn.id,
        detail: `Balance transaction currency ${txn.currency} differs from the run currency ${runCurrency}.`,
        amountMinor: txn.amountMinor,
      });
    }
    if (txn.status === "pending") {
      totals.pendingNetMinor += txn.netMinor;
    } else {
      totals.availableNetMinor += txn.netMinor;
    }
    if (bucket === "payout") {
      totals.payoutCount += 1;
      totals.payoutNetMinor += txn.netMinor;
      continue;
    }
    if (bucket === "other") {
      totals.otherCount += 1;
      totals.otherNetMinor += txn.netMinor;
      continue;
    }
    if (bucket === "charge") {
      if (txn.source) {
        matchedSources.add(txn.source);
        chargeAmountBySource.set(txn.source, txn);
      }
      if (attribution === "ddb") {
        totals.chargeCountDdb += 1;
        totals.grossChargesDdbMinor += txn.amountMinor;
        totals.feesDdbMinor += txn.feeMinor;
        totals.netDdbMinor += txn.netMinor;
      } else if (attribution === "external") {
        totals.chargeCountExternal += 1;
        totals.grossChargesExternalMinor += txn.amountMinor;
        totals.feesExternalMinor += txn.feeMinor;
        totals.netExternalMinor += txn.netMinor;
      } else {
        totals.unattributedCount += 1;
        totals.unattributedGrossMinor += txn.amountMinor;
        flags.push({
          kind: "unattributed_charge",
          ref: txn.source ?? txn.id,
          detail:
            "Stripe charge could not be attributed to a lane — inspect in the Stripe dashboard.",
          amountMinor: txn.amountMinor,
        });
      }
      continue;
    }
    // Refund bucket.
    const refundLane =
      attribution === "ddb" ? "ddb" : attribution === "external" ? "external" : "unattributed";
    if (refundLane === "ddb") {
      totals.refundCountDdb += 1;
      totals.refundsDdbMinor += -txn.amountMinor;
      totals.feesDdbMinor += txn.feeMinor;
      totals.netDdbMinor += txn.netMinor;
    } else if (refundLane === "external") {
      totals.refundCountExternal += 1;
      totals.refundsExternalMinor += -txn.amountMinor;
      totals.feesExternalMinor += txn.feeMinor;
      totals.netExternalMinor += txn.netMinor;
    } else {
      totals.unattributedCount += 1;
      totals.unattributedGrossMinor += -txn.amountMinor;
      flags.push({
        kind: "unattributed_refund",
        ref: txn.source ?? txn.id,
        detail:
          "Stripe refund could not be attributed to a lane — inspect in the Stripe dashboard.",
        amountMinor: -txn.amountMinor,
      });
    }
  }

  // Cross-check: every card payment expected in range should have produced
  // a matching charge transaction at the recorded amount.
  for (const payment of payments) {
    if (payment.expectsCharge && !matchedPaymentIds.has(payment.paymentId)) {
      const seen =
        (payment.chargeId && matchedSources.has(payment.chargeId)) ||
        (payment.paymentIntentId && matchedSources.has(payment.paymentIntentId));
      if (!seen) {
        flags.push({
          kind: "missing_charge",
          ref: payment.paymentId,
          detail:
            "A settled DDB card payment has no matching Stripe balance transaction in range.",
          amountMinor: payment.amountMinor,
        });
      } else {
        const source =
          payment.chargeId && matchedSources.has(payment.chargeId)
            ? payment.chargeId
            : payment.paymentIntentId!;
        const txn = chargeAmountBySource.get(source);
        if (txn && txn.amountMinor !== payment.amountMinor) {
          flags.push({
            kind: "amount_mismatch",
            ref: payment.paymentId,
            detail: `Stripe reports gross ${txn.amountMinor} but the payment records ${payment.amountMinor}.`,
            amountMinor: payment.amountMinor,
          });
        }
      }
    }
    if (
      payment.expectsRefund &&
      payment.refundId &&
      !classified.some(
        (c) => c.bucket === "refund" && c.txn.source === payment.refundId
      )
    ) {
      flags.push({
        kind: "missing_refund",
        ref: payment.paymentId,
        detail:
          "The recorded refund has no matching Stripe balance transaction in range.",
      });
    }
  }

  return { totals, flags };
}

// --- Admin-facing serialized view ---

// One existing QuickBooks entry that already touches a watched account
// (the clearing account or the mapped fee expense account) inside the
// report window — the "is anyone already booking this?" evidence the
// accountant reviews before any new fee entry is ever proposed.
export interface QboReconLedgerItem {
  entityType: string;
  id: string;
  txnDate?: string;
  docNumber?: string;
  memo?: string;
  /** Signed minor-unit effect of the entry's legs on watched accounts. */
  amountMinor: number;
  /** Watched account ids the entry touches (subset — not every leg). */
  accountIds: string[];
}

export interface QboReconRunView {
  environment: QboEnvironment;
  realmIdShort?: string;
  ranAt: string;
  ranByEmail?: string;
  range: { from: string; to: string };
  currency: string;
  /** Stripe's reported balance (all sources — the account is shared). */
  stripeAvailableMinor?: number;
  stripePendingMinor?: number;
  /** QBO ledger balance of the mapped clearing account, when reliably
   *  available (connection + mapping present and the read succeeded). */
  qboClearingBalanceMinor?: number;
  /** `qboClearing − stripeAvailable`. The clearing account intentionally
   *  holds retained funds, so a non-zero difference is not inherently an
   *  error — it is the number the accountant reconciles. */
  clearingDifferenceMinor?: number;
  /** Ledger balance of the mapped fee expense account, when mapped and
   *  readable — a signal for whether fee expense is already booked. */
  qboFeeBalanceMinor?: number;
  /** Existing QBO entries touching the watched clearing/fee accounts in
   *  range — bank-feed adjustments, expense entries, and transfers that
   *  must be inspected before any new fee entry is proposed. */
  qboLedgerItems: QboReconLedgerItem[];
  /** Signed net effect of `qboLedgerItems` on the clearing account. */
  qboClearingActivityMinor?: number;
  qboActivityTruncated: boolean;
  /** Clearing balance recorded by the previous run, when one exists —
   *  the roll-forward baseline for in-range movement. */
  previousClearingBalanceMinor?: number;
  /** Stripe-side net movement inside the range (all lanes). */
  netMovementMinor: number;
  totals: QboReconTotals;
  flags: QboReconFlag[];
  flagsTruncated: boolean;
  stripeScanTruncated: boolean;
  paymentsScanTruncated: boolean;
  enrichmentTruncated: boolean;
  /** False when QuickBooks is not configured/connected — the Stripe side
   *  still reconciles; the clearing balance is simply unavailable. */
  qboAvailable: boolean;
}
