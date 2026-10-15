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
//   - An Ollie-owned movement is *verified* when a namespaced identifier
//     chain proves identity — e.g. a Stripe-side "Ollie Order #00327"
//     matching the linked QBO invoice's DocNumber, or an Ollie payment
//     number matching the QBO PaymentRefNum — inside the amount/currency/
//     window gates. *Suggested* is a unique amount+date candidate with no
//     identifier evidence — review-grade, never execution-grade.
//     Conflicting identifiers or several plausible payments fail closed
//     to `ambiguous`; nothing unmatched is ever proposed.
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
  /** Stripe's own test/live flag on the object — environment-isolation
   *  evidence for manual sync-by-id. */
  livemode?: boolean;
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
  /** DocNumbers of the linked invoices, resolved by a follow-up Invoice
   *  read — the invoice number equals the Ollie order number (verified
   *  against real records: Ollie order #00327 → QBO invoice #00327). */
  linkedDocNumbers?: string[];
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
  | "verified" // Ollie path + shared namespaced identifier (order↔invoice
  //            DocNumber, payment↔PaymentRefNum, invoice↔DocNumber) —
  //            the only tier that can ever qualify for unattended posting
  | "suggested" // unique amount/date Ollie candidate — review-grade, never auto-posts
  | "ambiguous" // multiple candidates or conflicting identifiers — exception
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
  /** Matched Ollie payment (confidence "suggested"/"verified" only). */
  qboPaymentId?: string;
  qboPaymentRef?: string;
  customerName?: string;
  /** Namespaced identifiers that proved a verified match, e.g.
   *  "order:327" — namespace plus normalized digits, stable across
   *  padding differences. */
  identityRefs?: string[];
  /** Set when the line's QBO relationship comes from a previously
   *  *applied* reclassification rather than a fresh UF candidate match —
   *  the payment already moved out of Undeposited Funds, so it can never
   *  reappear in the candidate scan. `applied` = live QBO state confirms
   *  the recorded move; `conflict` = live state contradicts it
   *  (investigate — the exception log carries the detail); `unverified` =
   *  live revalidation was unreachable this run. */
  reconciled?: "applied" | "conflict" | "unverified";
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

// --- Ollie reference extraction ---
//
// Shared identifiers that can corroborate a Stripe⇄Ollie identity. Every
// reference is *namespaced* — an Ollie order number, an Ollie payment
// number, and a QBO invoice DocNumber are different numbering spaces that
// must never cross-match. Only *labeled* text counts as a reference:
// `Ollie Order #00327` yields order "327", but a bare `#00327` yields
// nothing — the label is what makes the digit string trustworthy.
export interface OllieRefSet {
  /** Ollie order numbers (Stripe descriptions/metadata). */
  orderNumbers: string[];
  /** Ollie payment numbers (QBO PaymentRefNum, "Ollie Payment #…"). */
  paymentNumbers: string[];
  /** Invoice numbers (QBO linked-invoice DocNumbers, Stripe invoice refs). */
  invoiceNumbers: string[];
}

export const EMPTY_OLLIE_REFS: OllieRefSet = {
  orderNumbers: [],
  paymentNumbers: [],
  invoiceNumbers: [],
};

const REF_DIGITS = /^\d{3,12}$/;

// Normalize a digit string for comparison — Ollie zero-pads order numbers
// ("00327"), so "00327" and "327" are the same reference.
function normalizeOllieRef(raw: string): string | null {
  const digits = raw.trim();
  if (!REF_DIGITS.test(digits)) return null;
  return String(parseInt(digits, 10));
}

const LABELED_REF_PATTERNS: {
  key: keyof OllieRefSet;
  re: RegExp;
}[] = [
  { key: "orderNumbers", re: /\border\s*#?\s*(\d{3,12})\b/gi },
  { key: "paymentNumbers", re: /\bpayment\s*#?\s*(\d{3,12})\b/gi },
  { key: "invoiceNumbers", re: /\binvoice\s*#?\s*(\d{3,12})\b/gi },
];

function addRef(refs: OllieRefSet, key: keyof OllieRefSet, raw: string) {
  const norm = normalizeOllieRef(raw);
  if (norm && !refs[key].includes(norm)) refs[key].push(norm);
}

// Labeled references inside free text (Stripe charge descriptions,
// statement descriptors, QBO memos). Unlabeled digit runs are ignored —
// an unlabeled "#1626166" could be an order, a payment, or a phone
// fragment, and guessing wrong is how false identities happen.
export function extractOllieRefsFromText(text: string, refs: OllieRefSet) {
  for (const { key, re } of LABELED_REF_PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      addRef(refs, key, m[1]);
    }
  }
}

// Metadata keys that name a namespace directly (Ollie writes keys like
// `order_id`/`orderNumber`; our own `paymentId`/`paymentIntent` keys are
// DDB/Stripe identifiers in a different space and are never Ollie refs).
const METADATA_KEY_NAMESPACES: Record<string, keyof OllieRefSet> = {
  order: "orderNumbers",
  orderid: "orderNumbers",
  ordernumber: "orderNumbers",
  ollieorder: "orderNumbers",
  ollieorderid: "orderNumbers",
  ollieordernumber: "orderNumbers",
  invoice: "invoiceNumbers",
  invoiceid: "invoiceNumbers",
  invoicenumber: "invoiceNumbers",
  ollieinvoice: "invoiceNumbers",
  ollieinvoiceid: "invoiceNumbers",
  ollieinvoicenumber: "invoiceNumbers",
  olliepayment: "paymentNumbers",
  olliepaymentid: "paymentNumbers",
  olliepaymentnumber: "paymentNumbers",
  paymentnumber: "paymentNumbers",
  paymentref: "paymentNumbers",
  paymentreference: "paymentNumbers",
};

export function extractOllieRefsFromMetadata(
  metadata: Record<string, string>,
  refs: OllieRefSet
) {
  for (const [key, value] of Object.entries(metadata)) {
    // Text inside the value may itself carry labeled refs.
    extractOllieRefsFromText(value, refs);
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    const ns = METADATA_KEY_NAMESPACES[normalizedKey];
    if (ns) addRef(refs, ns, value);
  }
}

// --- Spreedly composite identity ---
//
// Ollie runs Stripe charges through Spreedly, which stamps two metadata
// keys on the charge: `connect_agent` naming the integration and a
// composite `order_id` of the form `<Ollie order>-<Ollie payment ref>`
// (observed production values: `00327-1626166`, `00326-1623638`). The
// order number is the QBO invoice DocNumber; the payment ref is the QBO
// PaymentRefNum — two independently corroboratable identifiers pinned
// to one claimed relationship. Leading zeros are preserved through
// parsing; comparison normalizes them the same way `addRef` does.
export interface SpreedlyIdentity {
  /** Ollie order number, normalized (leading zeros stripped — "00326" →
   *  "326"), matching the OllieRefSet convention on both sides. */
  orderNumber: string;
  /** Ollie payment reference, normalized — the QBO PaymentRefNum. */
  paymentRef: string;
}

const SPREEDLY_ORDER_ID = /^(\d{3,12})-(\d{3,12})$/;
const SPREEDLY_AGENT = "spreedly";

// Strict, centralized parse: exactly two digit runs joined by one dash.
// Anything else — missing, extra segments, letters, mixed content —
// yields null and can never produce a verified identity.
export function parseSpreedlyOrderId(raw: string): SpreedlyIdentity | null {
  const m = SPREEDLY_ORDER_ID.exec(raw.trim());
  if (!m) return null;
  const orderNumber = normalizeOllieRef(m[1]);
  const paymentRef = normalizeOllieRef(m[2]);
  if (!orderNumber || !paymentRef) return null;
  return { orderNumber, paymentRef };
}

// The Stripe side of an Ollie identity attempt — enrichment facts plus
// the extracted reference set. `billingName` is used for conflict
// evidence only; it is never authoritative and never persisted on lines.
export interface OllieStripeIdentity {
  refs: OllieRefSet;
  customerName?: string;
  /** Spreedly composite claim — present only when `connect_agent`
   *  identifies the Spreedly integration AND `order_id` parses strictly
   *  as `<order>-<paymentRef>`. A claimed identity, not proof: the
   *  matcher verifies it only when BOTH legs independently corroborate
   *  on the same QBO payment. */
  spreedly?: SpreedlyIdentity;
}

// Extracts every namespaced Ollie reference a Stripe charge carries.
// Only labeled text and namespaced metadata keys count — unlabeled
// numbers never become identity evidence.
export function ollieIdentityFromChargeFacts(facts: {
  description?: string;
  statementDescriptor?: string;
  metadata?: Record<string, string>;
  billingName?: string;
}): OllieStripeIdentity {
  const refs: OllieRefSet = {
    orderNumbers: [],
    paymentNumbers: [],
    invoiceNumbers: [],
  };
  if (facts.description) extractOllieRefsFromText(facts.description, refs);
  if (facts.statementDescriptor) {
    extractOllieRefsFromText(facts.statementDescriptor, refs);
  }
  if (facts.metadata) extractOllieRefsFromMetadata(facts.metadata, refs);
  // The composite claim requires Spreedly provenance — a stray
  // `order_id` on a charge from anywhere else is an ordinary
  // (single-namespace) ref, never a two-leg identity.
  let spreedly: SpreedlyIdentity | undefined;
  const agent = facts.metadata?.connect_agent?.trim().toLowerCase();
  if (agent === SPREEDLY_AGENT && facts.metadata?.order_id) {
    const parsed = parseSpreedlyOrderId(facts.metadata.order_id);
    if (parsed) {
      spreedly = parsed;
      if (!refs.orderNumbers.includes(parsed.orderNumber)) {
        refs.orderNumbers.push(parsed.orderNumber);
      }
      if (!refs.paymentNumbers.includes(parsed.paymentRef)) {
        refs.paymentNumbers.push(parsed.paymentRef);
      }
    }
  }
  return { refs, customerName: facts.billingName, spreedly };
}

// A QBO payment's namespaced references: PaymentRefNum is the Ollie
// payment reference (the field's own semantics label it — bare digits
// count here), the memo carries labeled "Ollie Payment/Order #…" refs,
// and linkedDocNumbers are invoice numbers by construction.
export function ollieRefsFromQboPayment(
  payment: Pick<QboUndepositedPayment, "refNumber" | "memo" | "linkedDocNumbers">
): OllieRefSet {
  const refs: OllieRefSet = {
    orderNumbers: [],
    paymentNumbers: [],
    invoiceNumbers: [],
  };
  if (payment.refNumber) {
    extractOllieRefsFromText(payment.refNumber, refs);
    if (
      refs.paymentNumbers.length === 0 &&
      refs.orderNumbers.length === 0 &&
      refs.invoiceNumbers.length === 0
    ) {
      // Bare digits in PaymentRefNum are still the Ollie payment number.
      addRef(refs, "paymentNumbers", payment.refNumber);
    }
  }
  if (payment.memo) extractOllieRefsFromText(payment.memo, refs);
  for (const doc of payment.linkedDocNumbers ?? []) {
    // DocNumber can be padded ("00327") or prefixed ("INV-00327") — the
    // trailing digit run is the invoice number.
    const runs = doc.match(/\d{3,12}/g);
    if (runs) addRef(refs, "invoiceNumbers", runs[runs.length - 1]);
  }
  return refs;
}

// Namespaced comparison across the documented identity chains. Ollie
// order #N becomes QBO invoice DocNumber N, so Stripe `order` refs are
// compared against BOTH the payment's order refs and its linked-invoice
// DocNumbers; `invoice` ↔ DocNumber and `payment` ↔ PaymentRefNum are
// direct. A chain populated on BOTH sides must intersect (hit) or it
// contradicts the candidate (conflict); empty on either side contributes
// nothing — absence is not a conflict.
export function compareOllieRefs(
  stripe: OllieRefSet,
  qbo: OllieRefSet
): { hits: string[]; conflicts: string[] } {
  const hits: string[] = [];
  const conflicts: string[] = [];
  const chains: [keyof OllieRefSet, keyof OllieRefSet, string][] = [
    ["orderNumbers", "orderNumbers", "order"],
    ["orderNumbers", "invoiceNumbers", "order-invoice"],
    ["invoiceNumbers", "invoiceNumbers", "invoice"],
    ["paymentNumbers", "paymentNumbers", "payment"],
  ];
  const conflicted = new Set<string>();
  for (const [stripeKey, qboKey, label] of chains) {
    const s = stripe[stripeKey];
    const q = qbo[qboKey];
    if (!s.length || !q.length) continue;
    const shared = s.filter((v) => q.includes(v));
    if (shared.length) {
      hits.push(...shared.map((v) => `${label}:${v}`));
    } else {
      conflicted.add(label);
    }
  }
  // A hit on one leg of a chain namespace pairing does not excuse a
  // disjoint counterpart — report each distinct conflicted chain once.
  conflicts.push(...conflicted);
  return { hits, conflicts };
}

function hasAnyRef(refs: OllieRefSet): boolean {
  return (
    refs.orderNumbers.length > 0 ||
    refs.paymentNumbers.length > 0 ||
    refs.invoiceNumbers.length > 0
  );
}

// Matches ONE charge-shaped balance transaction against the QBO payments
// still sitting in Undeposited Funds. The candidate set must already be
// UF-filtered and must exclude payments claimed by other payouts. Amount
// and date are evidence, never identity — a unique hit is "suggested",
// proposed for review only. A namespaced shared identifier (order↔
// invoice DocNumber, payment↔PaymentRefNum, invoice↔DocNumber) on a
// single conflict-free candidate upgrades it to "verified" — the tier an
// execution path may eventually act on. Conflicting identifiers or
// multiple identity hits fail closed to "ambiguous".
export function matchOlliePayment(
  txn: { amountMinor: number; currency: string; createdMs?: number },
  candidates: QboUndepositedPayment[],
  payoutCurrency: string,
  identity?: OllieStripeIdentity
): {
  confidence: Exclude<MatchConfidence, "confirmed" | "none">;
  payment?: QboUndepositedPayment;
  candidateIds: string[];
  evidence: string[];
  /** Namespaced identifier hits (`order:327`) for verified matches. */
  identityRefs?: string[];
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
  const baseEvidence = (payment: QboUndepositedPayment): string[] => [
    "exact_amount",
    payment.currency ? "currency_match" : "currency_unverified",
    chargeMs !== null && qboDateMs(payment.txnDate) !== null
      ? "date_in_window"
      : "date_unverified",
  ];

  // Identity pass — namespaced references can upgrade a candidate to
  // `verified` or veto it to `ambiguous`, but never soften the
  // amount/currency/window gates above.
  if (identity && hasAnyRef(identity.refs) && matching.length > 0) {
    const hits: {
      payment: QboUndepositedPayment;
      identityRefs: string[];
    }[] = [];
    let conflicts = 0;
    for (const candidate of matching) {
      const cmp = compareOllieRefs(
        identity.refs,
        ollieRefsFromQboPayment(candidate)
      );
      if (cmp.hits.length > 0 && cmp.conflicts.length === 0) {
        hits.push({ payment: candidate, identityRefs: cmp.hits });
      } else if (cmp.conflicts.length > 0) {
        conflicts += 1;
      }
    }
    // Two+ identity hits means the identifier cannot distinguish them —
    // fail closed. A conflict on a NON-hit candidate merely excludes a
    // look-alike (another order's same-amount payment); it does not veto
    // a clean hit. But when NOTHING hits and at least one candidate
    // actively contradicts, identity evidence exists and disagrees —
    // that is ambiguous, not "suggested".
    if (hits.length > 1 || (hits.length === 0 && conflicts > 0)) {
      return {
        confidence: "ambiguous",
        candidateIds: matching.map((candidate) => candidate.id),
        evidence: [
          hits.length > 1
            ? "multiple_identity_matches"
            : "identifier_conflict",
        ],
      };
    }
    if (hits.length === 1) {
      const hit = hits[0];
      const evidence = [...baseEvidence(hit.payment), "identity_match"];
      // Customer agreement corroborates; a mismatch demotes the hit —
      // identifiers proved which payment this is, but a different
      // customer on it warrants human eyes before it counts as verified.
      const stripeName = identity.customerName?.trim().toLowerCase();
      const qboName = hit.payment.customerName?.trim().toLowerCase();
      const customerConflict = Boolean(stripeName && qboName && stripeName !== qboName);
      if (customerConflict) {
        evidence.push("customer_mismatch");
        return {
          confidence: "suggested",
          payment: hit.payment,
          candidateIds: [hit.payment.id],
          evidence,
          identityRefs: hit.identityRefs,
        };
      }
      // A Spreedly composite claim is held to a stricter standard than a
      // lone namespaced ref: BOTH legs must positively corroborate on
      // the same payment — the Ollie payment ref ↔ PaymentRefNum AND the
      // order number ↔ a linked-invoice DocNumber. One leg hitting while
      // the other has no QBO data means the linkage cannot be confirmed
      // — review-required, not verified. (A contradicting leg already
      // counted as a conflict and never reaches this branch.)
      if (identity.spreedly) {
        const legs = new Set(
          hit.identityRefs.map((ref) => ref.split(":")[0])
        );
        const paymentLeg = legs.has("payment");
        const orderLeg = legs.has("order") || legs.has("order-invoice");
        if (!paymentLeg || !orderLeg) {
          evidence.push("spreedly_linkage_unverified");
          if (matching.length > 1) evidence.push("identity_disambiguated");
          return {
            confidence: "suggested",
            payment: hit.payment,
            candidateIds: [hit.payment.id],
            evidence,
            identityRefs: hit.identityRefs,
          };
        }
        evidence.push("spreedly_identity");
      }
      if (stripeName && qboName) evidence.push("customer_consistent");
      if (matching.length > 1) evidence.push("identity_disambiguated");
      return {
        confidence: "verified",
        payment: hit.payment,
        candidateIds: [hit.payment.id],
        evidence,
        identityRefs: hit.identityRefs,
      };
    }
    // Stripe carried references but no candidate shares or contradicts
    // them — fall through to circumstantial matching, flagged.
    if (matching.length === 1) {
      const payment = matching[0];
      const qboRefs = ollieRefsFromQboPayment(payment);
      return {
        confidence: "suggested",
        payment,
        candidateIds: [payment.id],
        evidence: [
          ...baseEvidence(payment),
          hasAnyRef(qboRefs)
            ? "identifier_unverified"
            : "no_identifier_evidence",
        ],
      };
    }
    return {
      confidence: "ambiguous",
      candidateIds: matching.map((candidate) => candidate.id),
      evidence: ["multiple_candidates"],
    };
  }

  if (matching.length === 1) {
    const payment = matching[0];
    const evidence = baseEvidence(payment);
    const qboRefs = ollieRefsFromQboPayment(payment);
    if (hasAnyRef(qboRefs)) evidence.push("ollie_reference_only");
    return {
      confidence: "suggested",
      payment,
      candidateIds: [payment.id],
      evidence,
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
    | "cutover_skipped"
    | "reconciled_state_conflict";
  ref: string;
  detail: string;
  amountMinor?: number;
}

/** A QBO payment relationship this payout already established through
 *  an applied `move_payment_to_clearing` proposal — the durable record
 *  of a completed reconciliation. Built by the caller from persisted
 *  proposal/execution docs, then revalidated against live QBO state. */
export interface ReconciledPayment {
  /** QBO payment id the applied move bound to (== the proposal's
   *  `qboRefs.paymentId`, which required explicit admin confirmation). */
  paymentId: string;
  paymentRef?: string;
  customerName?: string;
  /** The confidence the line was matched with — preserved verbatim.
   *  A `suggested` match stays `suggested` forever; completing the
   *  accounting action never upgrades it. */
  confidence: Exclude<MatchConfidence, "none" | "unmatched" | "ambiguous">;
  /** Identity refs the original match carried, when recorded. */
  identityRefs?: string[];
  /** Live-state verification of the applied move:
   *  - `applied`: payment exists and sits in the account the proposal
   *    moved it to, at the approved amount/currency.
   *  - `conflict`: live state contradicts the durable record — deleted,
   *    moved to an unexpected account, amount/currency changed, or back
   *    in Undeposited Funds. Reported as `reconciled_state_conflict`.
   *  - `unverified`: revalidation was unreachable (QBO leg down) — the
   *    identity is kept (an outage is not evidence) but flagged. */
  state: "applied" | "conflict" | "unverified";
  conflictDetail?: string;
}

export interface BuildPayoutLedgerInput {
  payout: StripePayoutFacts;
  txns: StripePayoutTxn[];
  ddbIndex: DdbPaymentIndex;
  /** Enrichment results for unresolved charge sources: sourceId →
   *  owning PaymentIntent / application payment id plus the extracted
   *  Ollie-side identity references for the matcher. */
  resolvedChargeFacts: ReadonlyMap<
    string,
    {
      paymentIntentId?: string;
      paymentId?: string;
      ollieIdentity?: OllieStripeIdentity;
    }
  >;
  /** UF-filtered QBO payments not claimed by another payout. */
  ollieCandidates: QboUndepositedPayment[];
  /** QBO payment ids already claimed by OTHER payouts' proposals. */
  claimedPaymentIds: ReadonlySet<string>;
  /** Durable reconciliation evidence keyed by Stripe balance-txn id:
   *  payments this payout already reclassified through an applied
   *  move proposal (server-validated at apply, revalidated live by the
   *  caller). A matched-and-moved payment leaves the UF candidate set
   *  forever — without this map a rebuild would demote the line to
   *  `external/unmatched` and forget a confirmed relationship. */
  reconciledMoves?: ReadonlyMap<string, ReconciledPayment>;
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
  // Reserve every durably-bound payment id up front — Stripe returns
  // balance transactions newest first, so without this a newer charge
  // could amount/date-match an older reconciled payment that drifted
  // back into Undeposited Funds before its own line is reached.
  const claimed = new Set<string>(
    [...(input.reconciledMoves?.values() ?? [])].map(
      (reconciled) => reconciled.paymentId
    )
  );
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
    let identityRefs: string[] | undefined;
    let reconciledState: StripePayoutLine["reconciled"];

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
      // ledger is denominated in one currency and never mixes. The
      // `payout`-type balance transaction is the payout's own debit —
      // Stripe includes it in the `?payout=` constituent list — so it
      // must stay out of the net sum or every ledger reads as double the
      // payout short. Minimum-balance hold/release movements stay in:
      // they legitimately explain why the paid amount differs from the
      // charge nets.
      if (txn.type !== "payout") {
        totals.computedNetMinor += txn.netMinor;
      }
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
      } else if (isRefundBucket(txn.type)) {
        // Refunds are never reclassified through an Undeposited-Funds
        // payment — a negative movement can never equal a positive QBO
        // payment, and splitting or netting them is not attempted. They
        // are reported as exceptions so the payout review is complete.
        lane = "external";
        confidence = "unmatched";
        evidence.push("refund_not_reclassifiable");
        exceptions.push({
          code: "unmatched_movement",
          ref: txn.txnId,
          detail:
            "Refund — Stripe refunds are never reclassified through Ollie payments; review manually.",
          amountMinor: txn.grossMinor,
        });
      } else if (isChargeBucket(txn.type)) {
        // Durable reconciliation evidence wins over a fresh candidate
        // match: a payment already reclassified out of Undeposited Funds
        // can never reappear in the UF scan, but the relationship it
        // established is the authoritative classification.
        const reconciled = input.reconciledMoves?.get(txn.txnId);
        if (reconciled) {
          lane = "ollie";
          confidence = reconciled.confidence;
          qboPaymentId = reconciled.paymentId;
          qboPaymentRef = reconciled.paymentRef;
          customerName = reconciled.customerName;
          if (reconciled.identityRefs?.length) {
            identityRefs = reconciled.identityRefs;
          }
          reconciledState = reconciled.state;
          // The bound payment was already reserved in `claimed` before
          // the loop — no other line in this build can re-match it even
          // if it drifted back into Undeposited Funds.
          evidence.push(
            reconciled.state === "applied"
              ? "applied_reconciliation"
              : reconciled.state === "unverified"
                ? "applied_reconciliation_unverified"
                : "applied_reconciliation_conflict"
          );
          if (reconciled.state === "conflict") {
            exceptions.push({
              code: "reconciled_state_conflict",
              ref: txn.txnId,
              detail:
                reconciled.conflictDetail ??
                `QBO payment ${reconciled.paymentId} no longer matches the recorded reconciliation — investigate before further accounting.`,
              amountMinor: txn.grossMinor,
            });
          }
        } else {
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
            payoutCurrency,
            enriched?.ollieIdentity
          );
          evidence.push(...match.evidence);
          confidence = match.confidence;
          if (
            (match.confidence === "suggested" ||
              match.confidence === "verified") &&
            match.payment
          ) {
            lane = "ollie";
            qboPaymentId = match.payment.id;
            qboPaymentRef =
              match.payment.refNumber ?? match.payment.memo ?? undefined;
            customerName = match.payment.customerName;
            if (match.identityRefs?.length) identityRefs = match.identityRefs;
            claimed.add(match.payment.id);
          } else if (match.confidence === "ambiguous") {
            lane = "external";
            exceptions.push({
              code: "ambiguous_match",
              ref: txn.txnId,
              detail: match.evidence.includes("identifier_conflict")
              ? "Identifier evidence conflicts between the Stripe charge and the candidate payment(s) — no reclassification proposed."
              : match.evidence.includes("multiple_identity_matches")
                ? "More than one undeposited QuickBooks payment shares an Ollie identifier with this charge — no reclassification proposed."
                : `${match.candidateIds.length} undeposited QuickBooks payments match amount and window — no reclassification proposed.`,
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
      identityRefs,
      reconciled: reconciledState,
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

// Native QBO workflows each proposal describes (executed by the guarded
// executor in approval/automatic mode — these records are also the
// review/audit artifact):
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
  | "proposed" // computed, awaiting review
  | "blocked" // cannot become a valid posting (missing mapping, etc.)
  | "approved" // decided by an authorized admin — executable via apply
  | "rejected"
  | "applied" // posted to QBO by the guarded executor
  | "stale"; // the latest rebuild no longer produces this proposal —
  //            kept as review history, never executable. Not a decided
  //            status: a proposal that recomputes again revives to
  //            proposed/blocked on the next build.

export interface QboProposalParty {
  accountId?: string;
  /** Human-facing label resolved from the mapping's entity names. */
  label: string;
}

export interface QboProposalDecision {
  /** The admin decision recorded against a material fingerprint. */
  action: "approve" | "reject";
  actorUid: string;
  actorEmail?: string;
  /** ISO timestamp of the decision. */
  at: string;
  note?: string;
  /** The fingerprint the decision was recorded against — a proposal
   *  whose recomputed fingerprint differs is no longer decided. */
  fingerprint: string;
  /** True when the system granted this approval under automatic mode.
   *  An automation approval only stands while the proposal still
   *  qualifies for unattended execution — the fingerprint binds the
   *  material facts, not the eligibility that let it skip review. */
  auto?: boolean;
  /** Approving a payment reclassification requires the admin to confirm
   *  the exact QBO payment identity. The confirmed id is recorded here
   *  so the executor can verify the reviewed payment is the one being
   *  moved — a `suggested` match can never ride an unconfirmed
   *  approval. */
  confirmedQboPaymentId?: string;
}

export interface QboAccountingProposal {
  /** Deterministic id — also the idempotency key for any future
   *  execution. `${environment}:${payoutId}:${kind}:${key}` */
  proposalId: string;
  environment: QboEnvironment;
  payoutId: string;
  kind: QboProposalKind;
  status: QboProposalStatus;
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
  /** Fingerprint of the material facts an approval binds to — amount,
   *  currency, source/destination accounts, payment identity, evidence,
   *  and the scope that made it eligible. Recomputed by every build; a
   *  stored decision whose fingerprint no longer matches is invalid. */
  materialFingerprint?: string;
  /** Latest recorded admin decision (if any). History lives in
   *  `decisions` — this is the current decision only. */
  decision?: QboProposalDecision;
  /** Durable decision history — every recorded decision with its
   *  fingerprint binding, newest last. `decision` alone loses the prior
   *  record when a second decision lands. */
  decisions?: QboProposalDecision[];
  /** Latest execution state written by the guarded executor — the
   *  durable record of apply attempts, outcomes, and the resulting QBO
   *  entity reference. Present only after at least one apply attempt. */
  execution?: {
    state: "in_progress" | "applied" | "failed" | "refused" | "uncertain";
    attempts: number;
    /** Epoch ms the in-progress claim lease runs to. Lets a reader
     *  distinguish a genuinely in-flight apply from an interrupted one
     *  whose lease already lapsed — the latter is safe to retry. */
    leaseUntilMs?: number;
    startedAt?: string;
    updatedAt?: string;
    errorCode?: string;
    errorMessage?: string;
    qboEntityType?: string;
    qboEntityId?: string;
    adopted?: boolean;
  };
  /** True when the proposal's evidence tier qualifies for unattended
   *  execution in `automatic` mode — verified-identifier moves, and
   *  aggregates whose payout is fully identified and fully in-scope.
   *  Never sufficient alone: the executor still requires the mode flag,
   *  a live proposal, and apply-time revalidation. */
  autoEligible?: boolean;
  /** True when the proposal covers pre-cutover movements — a manual,
   *  admin-driven path only. Historical proposals are never
   *  `autoEligible` and never executed by the automatic pass, whatever
   *  the accounting mode; they additionally require an explicit human
   *  approval (and, for reclassifications, a confirmed payment
   *  identity) bound to the material fingerprint. */
  historical?: boolean;
  /** The ledger line's match confidence, carried on move proposals so
   *  reviewers see whether the payment was `suggested` or `verified`
   *  without decoding evidence codes. */
  lineConfidence?: MatchConfidence;
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

// Material fingerprint: a stable digest of every fact an approver signs
// off on — the entry kind, amount/currency, accounting date, both legs'
// resolved accounts, the Stripe/QBO entity identity, and the evidence
// that justified the proposal (which encodes cutover scope, e.g.
// `partial_scope_eligible_lines_only`). An approval binds to this exact
// fingerprint; a rebuild that changes any material fact must require a
// fresh decision rather than silently carrying the old one forward.
export function proposalMaterialFingerprint(
  proposal: Pick<
    QboAccountingProposal,
    | "kind"
    | "amountMinor"
    | "currency"
    | "accountingDate"
    | "debit"
    | "credit"
    | "stripeRefs"
    | "qboRefs"
    | "evidence"
  >
): string {
  // JSON serialization per section: values can contain any delimiter,
  // so structured encoding keeps distinct material facts distinct.
  const refs = (record: Record<string, string>) =>
    JSON.stringify(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]])
    );
  return [
    proposal.kind,
    String(proposal.amountMinor),
    proposal.currency,
    proposal.accountingDate,
    `dr=${proposal.debit.accountId ?? ""}`,
    `cr=${proposal.credit.accountId ?? ""}`,
    `stripe=${refs(proposal.stripeRefs)}`,
    `qbo=${refs(proposal.qboRefs)}`,
    `ev=${JSON.stringify([...proposal.evidence].sort())}`,
  ].join("|");
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
   *  against the owner's historical manual habit). Fee coverage is
   *  tracked per share: an entry matching the pre-cutover fee sum
   *  suppresses only the historical proposal, one matching the eligible
   *  or total sum suppresses the eligible proposal; a transfer entry
   *  always covers the full paid amount and suppresses either. */
  existingCover?: {
    hasFeeEntry: boolean;
    hasTransferEntry: boolean;
    hasHistoricalFeeEntry?: boolean;
  };
  /** The company's Undeposited Funds account id, when resolvable —
   *  recorded as the move proposal's credit leg so an account change
   *  invalidates approvals like any other material fact. */
  undepositedFundsId?: string;
  /** False when the caller's balance-transaction fetch was truncated —
   *  the ledger is a partial picture of the payout and aggregate
   *  proposals must never run unattended on it. */
  ledgerComplete?: boolean;
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
      (line.confidence !== "suggested" && line.confidence !== "verified") ||
      !line.qboPaymentId ||
      // A reconciled line's move already happened through an applied
      // proposal — proposing a second reclassification for the same
      // payment would be a duplicate, and a `conflict` state needs
      // investigation, not another executable action.
      line.reconciled !== undefined
    ) {
      continue;
    }
    // Pre-cutover matched lines get a proposal too — flagged historical,
    // never auto-eligible, executable only through an explicit admin
    // approval that confirms the payment identity. Foreign-currency
    // lines stay out entirely.
    const historical = line.scope === "pre_cutover";
    if (line.scope !== "eligible" && !historical) continue;
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
      // Only a verified identifier chain can ever run unattended, and
      // never on a historical line — `suggested` and pre-cutover
      // matches stay review-only forever, even in automatic mode.
      autoEligible: !historical && line.confidence === "verified",
      historical: historical || undefined,
      lineConfidence: line.confidence,
      amountMinor: line.grossMinor,
      currency: line.currency,
      accountingDate,
      debit: {
        accountId: clearingId,
        label: name(clearingId, "Stripe clearing account"),
      },
      credit: {
        accountId: input.undepositedFundsId,
        label: "Undeposited Funds",
      },
      stripeRefs: {
        payoutId: payout.id,
        balanceTxnId: line.txnId,
        ...(line.sourceId ? { chargeId: line.sourceId } : {}),
        // The namespaced refs that carried the match — a rebuild that
        // resolves different identifiers is a material change even when
        // the matched payment stays the same.
        ...(line.identityRefs?.length
          ? { identity: [...line.identityRefs].sort().join(",") }
          : {}),
      },
      qboRefs: {
        paymentId: line.qboPaymentId,
        ...(line.qboPaymentRef ? { paymentRef: line.qboPaymentRef } : {}),
      },
      evidence: [
        ...line.evidence,
        ...(historical ? ["pre_cutover_manual_review"] : []),
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

  // Aggregate proposals can run unattended only when the ledger is a
  // complete, internally consistent picture of the payout — untruncated
  // fetch, balanced totals, single currency — and every charge-side
  // eligible movement is positively identified (DDB-confirmed or
  // verified-Ollie). The payout's own debit (`type === "payout"`) is an
  // account-level line with no match confidence — it is expected on
  // every paid payout and is never weighed. Any other account-level
  // movement (adjustment, dispute, unclassified) keeps the aggregates
  // manual, as does an unidentified or pre-cutover line: a human still
  // has to look at the payout, so its fee/transfer postings stay manual
  // too.
  const autoIdentityLines = eligibleLines.filter(
    (line) => line.type !== "payout"
  );
  const aggregateAutoEligible =
    input.ledgerComplete !== false &&
    ledger.totals.balanced &&
    autoIdentityLines.length > 0 &&
    !partialScope &&
    autoIdentityLines.every(
      (line) =>
        line.confidence === "confirmed" || line.confidence === "verified"
    );

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
      autoEligible: aggregateAutoEligible,
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
      autoEligible: aggregateAutoEligible,
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

  // Historical aggregates cover the pre-cutover share — the same
  // accounting entries as the eligible aggregates but over
  // `pre_cutover` lines, under a distinct `historical` key so both can
  // coexist on a straddling payout. They are always manual: never
  // auto-eligible, never touched by the automatic apply pass, and only
  // executable after an explicit admin approval. When a payout
  // straddles the cutover the eligible transfer is suppressed (it only
  // covers a partial payout anyway), so the historical transfer posts
  // the full paid amount — there is exactly one transfer proposal.
  const preCutoverLines = ledger.lines.filter(
    (line) => line.scope === "pre_cutover"
  );
  const preCutoverFeesMinor = preCutoverLines.reduce(
    (sum, line) => sum + line.feeMinor,
    0
  );
  const historicalEvidence = [
    "pre_cutover_manual_review",
    ...(partialScope ? ["partial_scope_eligible_lines_only"] : []),
  ];

  if (
    preCutoverFeesMinor > 0 &&
    !input.existingCover?.hasHistoricalFeeEntry
  ) {
    proposals.push({
      proposalId: qboProposalIdFor(
        environment,
        payout.id,
        "stripe_fee_expense",
        "historical"
      ),
      environment,
      payoutId: payout.id,
      kind: "stripe_fee_expense",
      status: clearingId && feeId ? "proposed" : "blocked",
      autoEligible: false,
      historical: true,
      amountMinor: preCutoverFeesMinor,
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
        ...historicalEvidence,
        ...(feeId ? [] : ["fee_account_unmapped"]),
        ...(clearingId ? [] : ["clearing_account_unmapped"]),
      ],
      mode,
    });
  }

  if (
    preCutoverLines.length > 0 &&
    payout.status === "paid" &&
    !input.existingCover?.hasTransferEntry
  ) {
    proposals.push({
      proposalId: qboProposalIdFor(
        environment,
        payout.id,
        "payout_transfer",
        "historical"
      ),
      environment,
      payoutId: payout.id,
      kind: "payout_transfer",
      status: clearingId && payoutAccountId ? "proposed" : "blocked",
      autoEligible: false,
      historical: true,
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
        ...historicalEvidence,
        ...(payoutAccountId ? [] : ["payout_account_unmapped"]),
        ...(clearingId ? [] : ["clearing_account_unmapped"]),
      ],
      mode,
    });
  }

  // Every emitted proposal is fingerprinted — approvals bind to these
  // exact material facts, and a rebuild that changes any of them must
  // require a fresh decision.
  for (const proposal of proposals) {
    proposal.materialFingerprint = proposalMaterialFingerprint(proposal);
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
  /** Proposals a rebuild no longer produces — review history, never
   *  executable. */
  staleCount: number;
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
  /** True only in approval/automatic mode — the executor exists but
   *  observe mode still refuses every write. */
  writesEnabled: boolean;
  cutover?: string;
  /** Last completed reconciliation run timestamp, when one exists. */
  lastReconAt?: string;
  payouts: StripePayoutView[];
  proposals: QboAccountingProposal[];
  /** False when the QBO leg could not be read (not connected etc.). */
  qboAvailable: boolean;
}

// --- Admin-triggered payout sync ---

// Per-payout outcome of a manual sync run. `processed` means the canonical
// ledger build ran — ingestion succeeded; it says nothing about proposal
// eligibility. `eligibleLines`/`preCutoverLines` carry that distinction: a
// fully pre-cutover payout is ingested with zero eligible lines, which the
// UI explains instead of implying proposals exist.
export interface StripePayoutSyncItem {
  payoutId: string;
  status: string;
  outcome:
    | "processed" // paid payout — canonical ledger (re)built this run
    | "status_recorded" // non-paid payout persisted without ledger work
    | "already_current" // stored ledger already matches canonical state
    | "not_found" // by-id only: no such payout in this Stripe environment
    | "lease_lost" // another invocation owns the lease — retry when free
    | "failed"; // processing threw — safe to retry
  /** Accounting proposals this run's build computed (0 = ingested with
   *  no eligible postings — e.g. every movement predates the cutover). */
  proposals?: number;
  eligibleLines?: number;
  preCutoverLines?: number;
}

export interface StripePayoutSyncSummary {
  environment: QboEnvironment;
  scope: "recent" | "single";
  /** Payouts the Stripe scan returned (1 for a by-id run). */
  discovered: number;
  /** Paid payouts whose canonical ledger (re)built this run. */
  processed: number;
  /** Non-paid payouts persisted status-only this run. */
  statusRecorded: number;
  alreadyCurrent: number;
  failed: number;
  /** Payouts still needing work after the process cap or a lease loss —
   *  a re-run continues from them; every step is idempotent. */
  remaining: number;
  /** The Stripe payout list itself was truncated — the lookback holds
   *  more payouts than the bounded scan reached. */
  scanTruncated: boolean;
  /** Configured automation cutover (YYYY-MM-DD), echoed so the UI can
   *  explain pre-cutover results. Undefined when no cutover is set. */
  cutover?: string;
  items: StripePayoutSyncItem[];
}
