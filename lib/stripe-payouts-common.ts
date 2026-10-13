// Shared, dependency-free vocabulary and pure logic for Stripe payout
// accounting automation (Stripe ⇄ Ollie/QuickBooks). Firebase-free so
// admin client components may import the view types; all provider IO and
// persistence lives in the server-only modules (lib/stripe-payouts.ts,
// lib/stripe-balance.ts, lib/qbo-api.ts).
//
// Automation modes: the engine always runs in "observe" for this phase —
// it classifies every payout movement and persists deterministic
// accounting proposals, but nothing posts to QuickBooks. The "approval"
// and "automatic" modes are reserved vocabulary for follow-up PRs that
// wire a reviewed execution path; configuring them today changes the
// reported mode label only, never behavior (there is no writer to arm).
//
// Matching is positive-evidence only:
//   - A Stripe movement is DDB-owned when an application-issued
//     identifier (charge id, PaymentIntent id, refund id, or the
//     `metadata.paymentId` the payment tool writes) proves it.
//   - An Ollie-owned movement is *suggested* only by a unique
//     Undeposited-Funds QBO payment matching exact amount (+currency when
//     QBO reports one) inside a bounded date window. Amount+date alone
//     can never auto-post — it yields a proposal for review, nothing
//     more. Multiple candidates or none at all become exceptions.
//   - Everything else is external/unmatched and never proposed.

import type { QboEnvironment } from "@/lib/qbo-common";

// --- Collections (deny-all to clients, like every qbo*/stripe* store) ---

export const STRIPE_PAYOUTS_COLLECTION = "stripePayouts";
export const QBO_ACCOUNTING_PROPOSALS_COLLECTION = "qboAccountingProposals";

// --- Stripe payout events ---

// The payout lifecycle events this integration consumes. Verified against
// the Stripe API event-type list: payout.created / updated / paid /
// failed / canceled are universal; payout.reconciliation_completed exists
// and, where the account emits it, marks the payout's constituent balance
// transactions as final — the preferred ledger trigger. payout.paid is
// the fallback trigger: the ledger rebuild is idempotent, so whichever
// arrives first builds it and the other refreshes it.
export const STRIPE_PAYOUT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "payout.created",
  "payout.updated",
  "payout.paid",
  "payout.failed",
  "payout.canceled",
  "payout.reconciliation_completed",
]);

// Events that justify fetching the payout's balance transactions.
// paid = funds left Stripe for the bank; reconciliation_completed =
// constituent transactions final. failed/canceled persist status only —
// there is nothing to reconcile.
export const STRIPE_PAYOUT_LEDGER_TRIGGERS: ReadonlySet<string> = new Set([
  "payout.paid",
  "payout.reconciliation_completed",
]);

export type StripePayoutStatus =
  | "pending"
  | "in_transit"
  | "paid"
  | "failed"
  | "canceled";

// --- Canonical provider facts ---

export interface StripePayoutFacts {
  id: string;
  status: string;
  amountMinor: number;
  /** Uppercase ISO-4217. */
  currency: string;
  /** Stripe's expected bank arrival, YYYY-MM-DD. */
  arrivalDate?: string;
  method?: string;
  type?: string;
  createdMs?: number;
}

// A single balance transaction belonging to the payout — same safe subset
// the reconciliation report uses (gross/fee/net exactly as Stripe reports
// them, integer minor units, never derived).
export interface StripePayoutTxn {
  txnId: string;
  /** Stripe balance-transaction type: charge, refund, fee, adjustment,
   *  contribution, dispute, … */
  type: string;
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: string;
  /** Originating object id (ch_…, re_…, …). */
  sourceId?: string;
  createdMs?: number;
}

// Canonical facts for one QBO Payment sitting in Undeposited Funds — the
// Ollie side of a match. Ollie payments carry no Stripe identifier, so
// everything here is descriptive evidence, not identity.
export interface QboUndepositedPayment {
  id: string;
  txnDate?: string;
  totalMinor: number;
  /** Account id the payment currently deposits into (must equal the
   *  discovered Undeposited Funds account to be a candidate). */
  depositToAccountId?: string;
  currency?: string;
  customerId?: string;
  customerName?: string;
  /** Ollie's own reference (PaymentRefNum / memo such as
   *  "Ollie Payment #1626166") — operator-facing evidence. */
  refNumber?: string;
  memo?: string;
  /** Invoice/txn ids the payment applies to. */
  linkedTxnIds: string[];
}

// --- Matching ---

// Lane assignment for one balance transaction.
//   ddb            — positive application identity (DDB website charge)
//   ollie          — unique UF payment matches amount+currency+window
//   external       — matches nothing we own (Ollie transactions not yet
//                    synced to QBO, other Stripe-connected services)
//   account_level  — fees, adjustments, disputes: no lane, ever
export type PayoutLane = "ddb" | "ollie" | "external" | "account_level";

export type MatchConfidence =
  | "confirmed" // id-linked (DDB payments record)
  | "suggested" // unique amount/date Ollie candidate — review-grade, never auto-posts
  | "ambiguous" // multiple candidates — exception
  | "unmatched" // no candidate — exception
  | "none"; // account-level movement — matching does not apply

export type LineScope =
  | "eligible" // at/after the automation cutover
  | "pre_cutover" // predates the configured cutover — reported, never proposed
  | "foreign_currency"; // currency differs from the payout currency

export interface StripePayoutLine extends StripePayoutTxn {
  lane: PayoutLane;
  confidence: MatchConfidence;
  scope: LineScope;
  /** DDB `payments` document id when positively identified. */
  paymentId?: string;
  /** Matched Ollie payment (confidence "suggested" only). */
  qboPaymentId?: string;
  qboPaymentRef?: string;
  customerName?: string;
  /** Short evidence codes explaining the classification. */
  evidence: string[];
}

// DDB identity for payout matching — same positive-identity model as the
// reconciliation report, reduced to lookup maps keyed by the ids Stripe
// actually reports on balance transactions and enriched objects.
export interface DdbPaymentIndex {
  /** charge id → payments doc id */
  byChargeId: ReadonlyMap<string, string>;
  /** PaymentIntent id → payments doc id */
  byIntentId: ReadonlyMap<string, string>;
  /** refund id → payments doc id */
  byRefundId: ReadonlyMap<string, string>;
  /** payments doc ids — matched via `metadata.paymentId` enrichment */
  paymentIds: ReadonlySet<string>;
}

export const EMPTY_DDB_INDEX: DdbPaymentIndex = {
  byChargeId: new Map(),
  byIntentId: new Map(),
  byRefundId: new Map(),
  paymentIds: new Set(),
};

export function buildDdbPaymentIndex(
  records: {
    paymentId: string;
    chargeId?: string;
    paymentIntentId?: string;
    refundId?: string;
  }[]
): DdbPaymentIndex {
  const byChargeId = new Map<string, string>();
  const byIntentId = new Map<string, string>();
  const byRefundId = new Map<string, string>();
  const paymentIds = new Set<string>();
  for (const record of records) {
    paymentIds.add(record.paymentId);
    if (record.chargeId) byChargeId.set(record.chargeId, record.paymentId);
    if (record.paymentIntentId)
      byIntentId.set(record.paymentIntentId, record.paymentId);
    if (record.refundId) byRefundId.set(record.refundId, record.paymentId);
  }
  return { byChargeId, byIntentId, byRefundId, paymentIds };
}

// How many days on either side of the charge date an Ollie payment may
// legitimately post — Ollie records the payment when it settles, which
// can lag (or rarely lead) the Stripe charge date.
export const OLLIE_MATCH_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

function txnDayMs(createdMs: number | undefined): number | null {
  return typeof createdMs === "number" ? createdMs : null;
}

function qboDateMs(txnDate: string | undefined): number | null {
  if (typeof txnDate !== "string") return null;
  const ms = Date.parse(`${txnDate}T00:00:00.000Z`);
  return Number.isNaN(ms) ? null : ms;
}

// Matches ONE charge-shaped balance transaction against the QBO payments
// still sitting in Undeposited Funds. The candidate set must already be
// UF-filtered and must exclude payments claimed by other payouts. Amount
// and date are evidence, never identity — a unique hit is "suggested",
// proposed for review only.
export function matchOlliePayment(
  txn: { amountMinor: number; currency: string; createdMs?: number },
  candidates: QboUndepositedPayment[],
  payoutCurrency: string
): {
  confidence: Exclude<MatchConfidence, "confirmed">;
  payment?: QboUndepositedPayment;
  candidateIds: string[];
  evidence: string[];
} {
  if (txn.currency !== payoutCurrency) {
    return {
      confidence: "unmatched",
      candidateIds: [],
      evidence: ["foreign_currency"],
    };
  }
  const chargeMs = txnDayMs(txn.createdMs);
  const spanMs = OLLIE_MATCH_WINDOW_DAYS * DAY_MS;
  const matching = candidates.filter((candidate) => {
    if (candidate.totalMinor !== txn.amountMinor) return false;
    // Currency is corroborating evidence: a QBO payment that reports a
    // different currency can never match; one that reports none is
    // allowed but noted — home-currency records commonly omit it.
    if (
      candidate.currency &&
      candidate.currency.toUpperCase() !== txn.currency
    ) {
      return false;
    }
    const payMs = qboDateMs(candidate.txnDate);
    if (chargeMs !== null && payMs !== null) {
      return Math.abs(payMs - chargeMs) <= spanMs;
    }
    // A missing date on either side narrows evidence but cannot
    // disqualify — uniqueness still gates the suggestion.
    return true;
  });
  if (matching.length === 1) {
    const payment = matching[0];
    return {
      confidence: "suggested",
      payment,
      candidateIds: [payment.id],
      evidence: [
        "exact_amount",
        ...(payment.currency ? ["currency_match"] : ["currency_unverified"]),
        ...(chargeMs !== null && qboDateMs(payment.txnDate) !== null
          ? ["date_in_window"]
          : ["date_unverified"]),
      ],
    };
  }
  if (matching.length > 1) {
    return {
      confidence: "ambiguous",
      candidateIds: matching.map((candidate) => candidate.id),
      evidence: ["multiple_candidates"],
    };
  }
  return { confidence: "unmatched", candidateIds: [], evidence: [] };
}

// --- Ledger construction ---

export interface PayoutTotals {
  lineCount: number;
  chargeCount: number;
  grossChargesMinor: number;
  feesMinor: number;
  refundCount: number;
  refundsMinor: number;
  adjustmentMinor: number;
  otherCount: number;
  /** Sum of every line's net in the payout currency. */
  computedNetMinor: number;
  /** Stripe's own payout amount — must equal computedNetMinor. */
  payoutAmountMinor: number;
  /** False when lines don't sum to the payout (data lag or truncation) —
   *  the report surfaces it rather than pretending agreement. */
  balanced: boolean;
  /** False when any line's currency differs from the payout currency —
   *  foreign lines are flagged and excluded from every total. */
  currencyConsistent: boolean;
}

export interface PayoutException {
  code:
    | "ambiguous_match"
    | "unmatched_movement"
    | "foreign_currency"
    | "existing_manual_entry"
    | "cutover_skipped";
  ref: string;
  detail: string;
  amountMinor?: number;
}

export interface BuildPayoutLedgerInput {
  payout: StripePayoutFacts;
  txns: StripePayoutTxn[];
  ddbIndex: DdbPaymentIndex;
  /** Enrichment results for unresolved charge sources: sourceId →
   *  owning PaymentIntent / application payment id. */
  resolvedChargeFacts: ReadonlyMap<
    string,
    { paymentIntentId?: string; paymentId?: string }
  >;
  /** UF-filtered QBO payments not claimed by another payout. */
  ollieCandidates: QboUndepositedPayment[];
  /** QBO payment ids already claimed by OTHER payouts' proposals. */
  claimedPaymentIds: ReadonlySet<string>;
  /** Automation cutover (YYYY-MM-DD) — txns created before it are
   *  classified but never proposed. Null = no cutover. */
  cutover?: string | null;
}

export interface BuiltPayoutLedger {
  lines: StripePayoutLine[];
  totals: PayoutTotals;
  exceptions: PayoutException[];
  /** Ollie candidate ids consumed by suggestions (the caller uses these
   *  to mark them claimed within this run). */
  claimedByThisPayout: string[];
}

function isChargeBucket(type: string): boolean {
  return type === "charge" || type === "payment";
}

function isRefundBucket(type: string): boolean {
  return type === "refund" || type === "payment_refund";
}

export function buildPayoutLedger(
  input: BuildPayoutLedgerInput
): BuiltPayoutLedger {
  const payoutCurrency = input.payout.currency;
  const cutoverMs = input.cutover
    ? qboDateMs(input.cutover) ?? undefined
    : undefined;
  const lines: StripePayoutLine[] = [];
  const exceptions: PayoutException[] = [];
  const claimed = new Set<string>();
  const totals: PayoutTotals = {
    lineCount: input.txns.length,
    chargeCount: 0,
    grossChargesMinor: 0,
    feesMinor: 0,
    refundCount: 0,
    refundsMinor: 0,
    adjustmentMinor: 0,
    otherCount: 0,
    computedNetMinor: 0,
    payoutAmountMinor: input.payout.amountMinor,
    balanced: false,
    currencyConsistent: true,
  };

  for (const txn of input.txns) {
    const evidence: string[] = [];
    let lane: PayoutLane;
    let confidence: MatchConfidence;
    let paymentId: string | undefined;
    let qboPaymentId: string | undefined;
    let qboPaymentRef: string | undefined;
    let customerName: string | undefined;

    const foreign = txn.currency !== payoutCurrency;
    if (foreign) {
      totals.currencyConsistent = false;
      lane = "external";
      confidence = "unmatched";
      exceptions.push({
        code: "foreign_currency",
        ref: txn.txnId,
        detail: `Balance transaction currency ${txn.currency} differs from the payout currency ${payoutCurrency} — excluded from all totals.`,
        amountMinor: txn.grossMinor,
      });
    } else {
      // Totals accumulate only for payout-currency lines — the whole
      // ledger is denominated in one currency and never mixes.
      totals.computedNetMinor += txn.netMinor;
      totals.feesMinor += txn.feeMinor;
      if (isChargeBucket(txn.type)) {
        totals.chargeCount += 1;
        totals.grossChargesMinor += txn.grossMinor;
      } else if (isRefundBucket(txn.type)) {
        totals.refundCount += 1;
        totals.refundsMinor += -txn.grossMinor;
      } else if (txn.type === "adjustment" || txn.type === "dispute") {
        totals.adjustmentMinor += txn.netMinor;
      } else {
        totals.otherCount += 1;
      }

      // Lane resolution. Charge/refund sources resolve DDB identity first
      // (stored ids, then bounded enrichment facts); everything else is
      // account-level or goes to the Ollie candidate match.
      const sourceId = txn.sourceId ?? "";
      const enriched = sourceId
        ? input.resolvedChargeFacts.get(sourceId)
        : undefined;
      const ddbHit =
        input.ddbIndex.byChargeId.get(sourceId) ??
        input.ddbIndex.byRefundId.get(sourceId) ??
        (enriched?.paymentIntentId
          ? input.ddbIndex.byIntentId.get(enriched.paymentIntentId)
          : undefined) ??
        (enriched?.paymentId &&
        input.ddbIndex.paymentIds.has(enriched.paymentId)
          ? enriched.paymentId
          : undefined);

      if (ddbHit) {
        lane = "ddb";
        confidence = "confirmed";
        paymentId = ddbHit;
        evidence.push("application_identity");
      } else if (isChargeBucket(txn.type) || isRefundBucket(txn.type)) {
        const available = input.ollieCandidates.filter(
          (candidate) =>
            !input.claimedPaymentIds.has(candidate.id) &&
            !claimed.has(candidate.id)
        );
        const match = matchOlliePayment(
          {
            amountMinor: txn.grossMinor,
            currency: txn.currency,
            createdMs: txn.createdMs,
          },
          available,
          payoutCurrency
        );
        evidence.push(...match.evidence);
        confidence = match.confidence;
        if (match.confidence === "suggested" && match.payment) {
          lane = "ollie";
          qboPaymentId = match.payment.id;
          qboPaymentRef =
            match.payment.refNumber ?? match.payment.memo ?? undefined;
          customerName = match.payment.customerName;
          claimed.add(match.payment.id);
        } else if (match.confidence === "ambiguous") {
          lane = "external";
          exceptions.push({
            code: "ambiguous_match",
            ref: txn.txnId,
            detail: `${match.candidateIds.length} undeposited QuickBooks payments match amount and window — no reclassification proposed.`,
            amountMinor: txn.grossMinor,
          });
        } else {
          lane = "external";
          exceptions.push({
            code: "unmatched_movement",
            ref: txn.txnId,
            detail:
              "No DDB record and no unique undeposited QuickBooks payment match — external or unmatched Stripe activity.",
            amountMinor: txn.grossMinor,
          });
        }
      } else {
        lane = "account_level";
        confidence = "none";
      }
    }

    const scope: LineScope = foreign
      ? "foreign_currency"
      : cutoverMs !== undefined &&
          typeof txn.createdMs === "number" &&
          txn.createdMs < cutoverMs
        ? "pre_cutover"
        : "eligible";
    if (scope === "pre_cutover") {
      exceptions.push({
        code: "cutover_skipped",
        ref: txn.txnId,
        detail:
          "Transaction predates the automation cutover — reported for historical review, never proposed.",
        amountMinor: txn.grossMinor,
      });
    }

    lines.push({
      ...txn,
      lane,
      confidence,
      scope,
      paymentId,
      qboPaymentId,
      qboPaymentRef,
      customerName,
      evidence,
    });
  }

  totals.balanced =
    totals.currencyConsistent &&
    totals.computedNetMinor === totals.payoutAmountMinor;

  return {
    lines,
    totals,
    exceptions,
    claimedByThisPayout: [...claimed],
  };
}

// --- Accounting proposals ---

// Native QBO workflows each proposal describes (execution is a follow-up
// PR — these records are the review/audit artifact):
//   move_payment_to_clearing — sparse-update the Ollie Payment's
//     DepositToAccountRef from Undeposited Funds to Stripe Clearing.
//     Never a journal entry: the Payment↔Invoice relationship and the
//     deposit workflow stay intact.
//   stripe_fee_expense — one Purchase per payout: debit the mapped fee
//     expense account, credit Stripe Clearing, for the payout's actual
//     total Stripe fees.
//   payout_transfer — one Transfer from Stripe Clearing to the mapped
//     payout account (bank, or a "Payouts in Transit" account per the
//     accountant's choice — the mapping decides which; see ops doc).
export type QboProposalKind =
  | "move_payment_to_clearing"
  | "stripe_fee_expense"
  | "payout_transfer";

export type QboProposalStatus =
  | "proposed" // computed, awaiting review (all statuses this phase emits)
  | "blocked" // cannot become a valid posting (missing mapping, etc.)
  | "approved" // decided by an authorized admin — not yet executable
  | "rejected"
  | "applied"; // posted to QBO — reserved for the execution follow-up

export interface QboProposalParty {
  accountId?: string;
  /** Human-facing label resolved from the mapping's entity names. */
  label: string;
}

export interface QboAccountingProposal {
  /** Deterministic id — also the idempotency key for any future
   *  execution. `${environment}:${payoutId}:${kind}:${key}` */
  proposalId: string;
  environment: QboEnvironment;
  payoutId: string;
  kind: QboProposalKind;
  status: QboProposalStatus;
  /** Present but not yet executable — approval is recorded by a
   *  follow-up surface; observe mode never produces it. */
  amountMinor: number;
  currency: string;
  /** The accounting date the eventual posting would carry. */
  accountingDate: string;
  debit: QboProposalParty;
  credit: QboProposalParty;
  stripeRefs: Record<string, string>;
  qboRefs: Record<string, string>;
  evidence: string[];
  /** Automation mode the proposal was computed under. */
  mode: StripeAccountingMode;
}

export type StripeAccountingMode = "observe" | "approval" | "automatic";
export const STRIPE_ACCOUNTING_MODES: readonly StripeAccountingMode[] = [
  "observe",
  "approval",
  "automatic",
];

// Deterministic, Firestore-safe proposal key (ids are legal document ids:
// no `/`, bounded length).
export function qboProposalIdFor(
  environment: QboEnvironment,
  payoutId: string,
  kind: QboProposalKind,
  key: string
): string {
  return `${environment}:${payoutId}:${kind}:${key}`.slice(0, 200);
}

export interface BuildProposalsInput {
  environment: QboEnvironment;
  payout: StripePayoutFacts;
  ledger: BuiltPayoutLedger;
  mode: StripeAccountingMode;
  mapping: {
    stripeClearingAccountId?: string;
    stripeFeeExpenseAccountId?: string;
    /** Destination for the payout transfer leg — the bank account, or a
     *  "Payouts in Transit" account per the accountant's choice. */
    stripePayoutAccountId?: string;
  };
  /** Display names for mapped account ids (mapping entityNames). */
  accountNames?: Record<string, string>;
  /** QBO entries already covering this payout — manual fee journals and
   *  manual transfers detected by the caller's activity scan. Presence
   *  suppresses the corresponding proposal (double-posting protection
   *  against the owner's historical manual habit). */
  existingCover?: { hasFeeEntry: boolean; hasTransferEntry: boolean };
}

// Builds the proposal set for one ledger. Only `eligible`-scope lines can
// generate proposals; suggestions produce `proposed`, missing mappings
// produce `blocked` (visible in the UI instead of silently skipped), and
// pre-existing manual QBO entries suppress the corresponding proposal —
// double-posting protection against the owner's historical manual habit.
export function buildPayoutProposals(
  input: BuildProposalsInput
): QboAccountingProposal[] {
  const { payout, ledger, mapping, environment, mode } = input;
  const proposals: QboAccountingProposal[] = [];
  const clearingId = mapping.stripeClearingAccountId;
  const feeId = mapping.stripeFeeExpenseAccountId;
  const payoutAccountId = mapping.stripePayoutAccountId;
  const name = (id: string | undefined, fallback: string) =>
    (id && input.accountNames?.[id]) || fallback;
  const accountingDate = payout.arrivalDate ?? "";

  for (const line of ledger.lines) {
    if (
      line.lane !== "ollie" ||
      line.confidence !== "suggested" ||
      !line.qboPaymentId
    ) {
      continue;
    }
    if (line.scope !== "eligible") continue;
    proposals.push({
      proposalId: qboProposalIdFor(
        environment,
        payout.id,
        "move_payment_to_clearing",
        line.qboPaymentId
      ),
      environment,
      payoutId: payout.id,
      kind: "move_payment_to_clearing",
      status: clearingId ? "proposed" : "blocked",
      amountMinor: line.grossMinor,
      currency: line.currency,
      accountingDate,
      debit: {
        accountId: clearingId,
        label: name(clearingId, "Stripe clearing account"),
      },
      credit: {
        label: "Undeposited Funds",
      },
      stripeRefs: {
        payoutId: payout.id,
        balanceTxnId: line.txnId,
        ...(line.sourceId ? { chargeId: line.sourceId } : {}),
      },
      qboRefs: {
        paymentId: line.qboPaymentId,
        ...(line.qboPaymentRef ? { paymentRef: line.qboPaymentRef } : {}),
      },
      evidence: [
        ...line.evidence,
        ...(clearingId ? [] : ["clearing_account_unmapped"]),
      ],
      mode,
    });
  }

  // Aggregate proposals cover eligible-scope lines only — a payout that
  // straddles the cutover must not post historical fees or the historical
  // share of the transfer. Foreign-currency lines are never eligible.
  const eligibleLines = ledger.lines.filter(
    (line) => line.scope === "eligible"
  );
  const eligibleFeesMinor = eligibleLines.reduce(
    (sum, line) => sum + line.feeMinor,
    0
  );
  const partialScope =
    eligibleLines.length > 0 &&
    ledger.lines.some((line) => line.scope === "pre_cutover");
  const scopeEvidence = partialScope
    ? ["partial_scope_eligible_lines_only"]
    : [];

  if (
    eligibleFeesMinor > 0 &&
    !input.existingCover?.hasFeeEntry
  ) {
    proposals.push({
      proposalId: qboProposalIdFor(
        environment,
        payout.id,
        "stripe_fee_expense",
        "aggregate"
      ),
      environment,
      payoutId: payout.id,
      kind: "stripe_fee_expense",
      status: clearingId && feeId ? "proposed" : "blocked",
      amountMinor: eligibleFeesMinor,
      currency: payout.currency,
      accountingDate,
      debit: {
        accountId: feeId,
        label: name(feeId, "Stripe fee expense account"),
      },
      credit: {
        accountId: clearingId,
        label: name(clearingId, "Stripe clearing account"),
      },
      stripeRefs: { payoutId: payout.id },
      qboRefs: {},
      evidence: [
        "actual_stripe_fees",
        ...scopeEvidence,
        ...(feeId ? [] : ["fee_account_unmapped"]),
        ...(clearingId ? [] : ["clearing_account_unmapped"]),
      ],
      mode,
    });
  }

  if (
    eligibleLines.length > 0 &&
    payout.status === "paid" &&
    !partialScope &&
    !input.existingCover?.hasTransferEntry
  ) {
    proposals.push({
      proposalId: qboProposalIdFor(
        environment,
        payout.id,
        "payout_transfer",
        "aggregate"
      ),
      environment,
      payoutId: payout.id,
      kind: "payout_transfer",
      status: clearingId && payoutAccountId ? "proposed" : "blocked",
      amountMinor: payout.amountMinor,
      currency: payout.currency,
      accountingDate,
      debit: {
        accountId: payoutAccountId,
        label: name(payoutAccountId, "Stripe payout account"),
      },
      credit: {
        accountId: clearingId,
        label: name(clearingId, "Stripe clearing account"),
      },
      stripeRefs: { payoutId: payout.id },
      qboRefs: {},
      evidence: [
        "payout_paid",
        ...(payoutAccountId ? [] : ["payout_account_unmapped"]),
        ...(clearingId ? [] : ["clearing_account_unmapped"]),
      ],
      mode,
    });
  }

  return proposals;
}

// --- Admin-facing view types ---

export interface StripePayoutView {
  payoutId: string;
  status: string;
  amountMinor: number;
  currency: string;
  arrivalDate?: string;
  automationMode: StripeAccountingMode;
  totals: PayoutTotals;
  /** Lane counts for the summary row. */
  laneCounts: { ddb: number; ollie: number; external: number; accountLevel: number };
  matchedPayments: number;
  unmatchedMovements: number;
  exceptionsCount: number;
  proposalCount: number;
  proposedCount: number;
  blockedCount: number;
  lastProcessedAt?: string;
  linesTruncated: boolean;
  /** Stored balance-transaction lines (cap 200) for the expandable
   *  detail row — absent before the first ledger build. */
  lines?: StripePayoutLine[];
  exceptions?: PayoutException[];
}

export interface StripePayoutAutomationView {
  configured: boolean;
  environment: QboEnvironment;
  mode: StripeAccountingMode;
  /** Always false in this phase — no QBO write path exists yet. */
  writesEnabled: false;
  cutover?: string;
  /** Last completed reconciliation run timestamp, when one exists. */
  lastReconAt?: string;
  payouts: StripePayoutView[];
  proposals: QboAccountingProposal[];
  /** False when the QBO leg could not be read (not connected etc.). */
  qboAvailable: boolean;
}
