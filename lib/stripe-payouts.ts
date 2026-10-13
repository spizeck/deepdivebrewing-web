import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { deepOmitUndefined } from "@/lib/firestore-safe";
import { isQboConfigured, getQboEnvironment } from "@/lib/qbo-config";
import { getQuickBooksAccessToken } from "@/lib/qbo-tokens";
import { getQboMappingView } from "@/lib/qbo-mapping";
import {
  findQboUndepositedFundsAccount,
  queryQboPayments,
  queryQboReconActivity,
} from "@/lib/qbo-api";
import { QBO_RECON_ACTIVITY_ENTITIES } from "@/lib/qbo-protocol";
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
} from "@/lib/stripe-config";
import {
  buildDdbPaymentIndex,
  buildPayoutLedger,
  buildPayoutProposals,
  STRIPE_PAYOUT_LEDGER_TRIGGERS,
  STRIPE_PAYOUTS_COLLECTION,
  QBO_ACCOUNTING_PROPOSALS_COLLECTION,
  type BuiltPayoutLedger,
  type PayoutException,
  type QboAccountingProposal,
  type QboUndepositedPayment,
  type StripePayoutAutomationView,
  type StripePayoutFacts,
  type StripePayoutView,
} from "@/lib/stripe-payouts-common";
import {
  PAYMENTS_COLLECTION,
  STRIPE_EVENTS_COLLECTION,
} from "@/lib/payments-common";
import { logError, logInfo, logWarn } from "@/lib/log";
import { QboError } from "@/lib/qbo-errors";
import type { QboEnvironment } from "@/lib/qbo-common";

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
    { paymentIntentId?: string; paymentId?: string }
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
  payout: StripePayoutFacts
): Promise<{
  candidates: QboUndepositedPayment[];
  claimedByOthers: Set<string>;
  available: boolean;
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
    return { candidates, claimedByOthers, available: true };
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
): Promise<{ hasFeeEntry: boolean; hasTransferEntry: boolean }> {
  const none = { hasFeeEntry: false, hasTransferEntry: false };
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
    // payout that is the eligible-line fee sum, not the ledger total.
    const eligibleFeesMinor = ledger.lines
      .filter((line) => line.scope === "eligible")
      .reduce((sum, line) => sum + line.feeMinor, 0);
    const coveredFeeAmounts = new Set(
      [ledger.totals.feesMinor, eligibleFeesMinor].filter((n) => n > 0)
    );
    let hasFeeEntry = false;
    let hasTransferEntry = false;
    for (const scan of scans) {
      for (const entry of scan.rows) {
        const hits = entry.legs.filter((leg) => watched.has(leg.accountId));
        if (!hits.length) continue;
        const feeLeg = hits.find(
          (leg) => leg.accountId === mapping.stripeFeeExpenseAccountId
        );
        if (feeLeg && coveredFeeAmounts.has(Math.abs(feeLeg.amountMinor))) {
          hasFeeEntry = true;
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
    return { hasFeeEntry, hasTransferEntry };
  } catch {
    return none;
  }
}

// Proposals already decided by an authorized admin must never be
// silently overwritten back to "proposed" by a ledger rebuild — the
// execution surface (follow-up PR) flips these and a recompute must
// respect them.
const DECIDED_PROPOSAL_STATUSES = new Set(["approved", "rejected", "applied"]);

export async function processStripePayoutLedger(
  payoutId: string
): Promise<void> {
  const environment = getQboEnvironment();
  const mode = getStripeAccountingMode();
  const cutover = getStripeAutomationCutover();
  const payout = await fetchStripePayout(payoutId);
  if (!payout) {
    logWarn("stripe.payout.ledger_missing", { payoutId });
    return;
  }

  const statusOnly = !["paid"].includes(payout.status);
  const { txns, truncated } = statusOnly
    ? { txns: [], truncated: false }
    : await listStripePayoutTransactions(payoutId, PAYOUT_TXN_MAX_PAGES);

  const { records: ddbRecords } = await loadDdbIdentityRecords(txns);
  const resolvedChargeFacts = await enrichChargeSources(txns, ddbRecords);
  const index = buildDdbPaymentIndex(ddbRecords);
  const ollie = await fetchOllieLeg(environment, payout);

  const ledger = buildPayoutLedger({
    payout,
    txns,
    ddbIndex: index,
    resolvedChargeFacts,
    ollieCandidates: ollie.candidates,
    claimedPaymentIds: ollie.claimedByOthers,
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
  });

  // Proposal persistence: deterministic ids make every rewrite idempotent
  // — a replayed event or second trigger converges to the same docs.
  const existing = await proposalsCollection()
    .where("payoutId", "==", payoutId)
    .where("environment", "==", environment)
    .limit(200)
    .get();
  const decided = new Map<string, string>();
  const priorAudit = new Map<
    string,
    { at: string; actor: string; note: string }[]
  >();
  for (const doc of existing.docs) {
    const data = doc.data();
    const status = data.status;
    if (typeof status === "string" && DECIDED_PROPOSAL_STATUSES.has(status)) {
      decided.set(doc.id, status);
    }
    if (Array.isArray(data.auditTrail)) {
      priorAudit.set(
        doc.id,
        data.auditTrail as { at: string; actor: string; note: string }[]
      );
    }
  }
  // Proposals that no longer recompute (e.g. a match resolved elsewhere)
  // are stale, not deleted — removing them would erase review history.
  const now = new Date().toISOString();
  const batch = getFirebaseAdminDb().batch();
  for (const proposal of proposals) {
    const trail = [
      ...(priorAudit.get(proposal.proposalId) ?? []),
      { at: now, actor: "system", note: `computed in ${mode} mode` },
    ].slice(-20);
    batch.set(
      proposalsCollection().doc(proposal.proposalId),
      deepOmitUndefined({
        ...proposal,
        status: decided.get(proposal.proposalId) ?? proposal.status,
        computedAt: FieldValue.serverTimestamp(),
        auditTrail: trail,
      }),
      { merge: true }
    );
  }

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

  batch.set(
    payoutRef(payout.id),
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
    { merge: true }
  );
  await batch.commit();
  logInfo("stripe.payout.ledger_built", {
    payoutId: payout.id,
    lines: ledger.lines.length,
    proposals: proposals.length,
    exceptions: exceptions.length,
    balanced: ledger.totals.balanced,
  });
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

  return {
    configured: true,
    environment,
    mode,
    writesEnabled: false,
    cutover: cutover ?? undefined,
    lastReconAt: input.lastReconAt,
    payouts,
    proposals,
    qboAvailable: isQboConfigured(),
  };
}

// --- Scheduled recovery sweep ---

// The fallback for missed webhook deliveries: list recent payouts and
// process any whose ledger is missing, pending, or behind the canonical
// status. Bounded per run — a large backlog drains over successive days
// rather than one runaway invocation.
export async function runStripePayoutSweep(): Promise<{
  scanned: number;
  processed: number;
  skipped: number;
}> {
  if (!isStripeConfigured()) {
    return { scanned: 0, processed: 0, skipped: 0 };
  }
  const environment = getQboEnvironment();
  const cutoffSec =
    Math.floor(Date.now() / 1000) - PAYOUT_SWEEP_LOOKBACK_DAYS * 86_400;
  const recent = await listRecentStripePayouts({
    createdGteSec: cutoffSec,
    limit: 50,
  });
  let processed = 0;
  let skipped = 0;
  for (const payout of recent) {
    if (processed >= PAYOUT_SWEEP_MAX_PROCESS) {
      skipped += 1;
      continue;
    }
    const snap = await payoutRef(payout.id).get();
    const stored = snap.exists ? snap.data() : undefined;
    const upToDate =
      stored &&
      stored.status === payout.status &&
      stored.pendingLedger !== true &&
      typeof stored.lastProcessedAt === "object";
    if (upToDate) {
      skipped += 1;
      continue;
    }
    try {
      if (payout.status !== "paid") {
        // Status-only payout: persist it without the ledger fetch so the
        // sweep's coverage includes failed/canceled receipts too.
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
            lastProcessedAt: FieldValue.serverTimestamp(),
            lastProcessedIso: new Date().toISOString(),
          }),
          { merge: true }
        );
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
  });
  return { scanned: recent.length, processed, skipped };
}
