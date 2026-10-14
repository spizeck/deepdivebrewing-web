import "server-only";
import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { getQboEnvironment } from "@/lib/qbo-config";
import { getQuickBooksAccessToken } from "@/lib/qbo-tokens";
import {
  getStripeAccountingMode,
  getStripeAutomationCutover,
} from "@/lib/stripe-config";
import {
  createQboJournalEntry,
  createQboTransfer,
  fetchQboPaymentById,
  findQboUndepositedFundsAccount,
  queryQboReconActivity,
  updateQboPaymentDepositAccount,
} from "@/lib/qbo-api";
import {
  buildQboJournalEntryPayload,
  buildQboTransferPayload,
  qboFeeEntryMarker,
  qboPayoutTransferMarker,
} from "@/lib/qbo-protocol";
import {
  QBO_ACCOUNTING_PROPOSALS_COLLECTION,
  STRIPE_PAYOUTS_COLLECTION,
  type QboAccountingProposal,
} from "@/lib/stripe-payouts-common";
import {
  QBO_STRIPE_PAYMENT_SOURCE_TYPE,
  QBO_SYNC_RECORDS_COLLECTION,
  qboSyncIdFor,
  type QboEnvironment,
} from "@/lib/qbo-common";
import { logError, logInfo } from "@/lib/log";
import { QboError } from "@/lib/qbo-errors";

// Guarded QuickBooks executor for payout accounting proposals. This is
// the module allowed to mutate the books — every safety property lives
// here, not in the route or the UI:
//
//   Mode        — observe refuses outright; approval requires an
//                 approved, fingerprint-bound decision.
//   Cutover     — no apply without a configured cutover, and a proposal
//                 whose accounting date precedes it can never execute.
//   Facts       — the stored proposal is re-read inside a transaction
//                 and its persisted decision must bind to the current
//                 materialFingerprint. QBO state is re-read again at
//                 apply time (payment account/amount/SyncToken); nothing
//                 executes on a cached match.
//   Idempotency — the proposalId is the execution identity; a Firestore
//                 claim lease allows exactly one in-flight attempt; the
//                 provider write carries a deterministic PrivateNote
//                 marker, and every attempt runs a recovery lookup first
//                 so a write that landed but lost its response is
//                 adopted, never duplicated.
//   Uncertainty — a write whose outcome is unknown (timeout, lost
//                 response, provider 5xx) parks the proposal in
//                 execution.state "uncertain". Retrying is allowed but
//                 always reconciles provider-side first.
//   DDB gross   — aggregate fee/transfer proposals refuse to post while
//                 an eligible DDB-originated line lacks a synced QBO
//                 sales-receipt record: a Stripe charge is not evidence
//                 the gross receipt exists in the books.

const EXECUTION_LEASE_MS = 2 * 60 * 1000;
// Never start a provider write this close to lease expiry — a successor
// reclaiming the claim would not know a write was in flight.
const MIN_LEASE_BEFORE_WRITE_MS = 30_000;
// Recovery scans look a few days around the accounting date: a landed
// entry posts on that date, so a tight window keeps the scan bounded.
const RECOVERY_WINDOW_DAYS = 7;

export type QboWrittenEntityType = "Payment" | "JournalEntry" | "Transfer";

export type ProposalApplyOutcome =
  | {
      outcome: "applied";
      qboEntityType: QboWrittenEntityType;
      qboEntityId: string;
      /** True when a prior attempt's write was found and adopted. */
      adopted: boolean;
    }
  | { outcome: "already_applied"; qboEntityId?: string }
  | { outcome: "in_progress" }
  // The provider write's result is unknown — retry reconciles first.
  | { outcome: "uncertain"; message: string }
  // A precondition failed — nothing was written; needs a rebuild or a
  // corrected mapping/decision, not a blind retry.
  | { outcome: "refused"; reason: string }
  // A retryable failure before the write (token, reads, lease).
  | { outcome: "failed"; reason: string }
  | { outcome: "missing" };

export interface ApplyProposalResult {
  proposalId: string;
  apply: ProposalApplyOutcome;
}

interface ProposalDoc extends QboAccountingProposal {
  auditTrail?: { at: string; actor: string; note: string }[];
  execution?: ProposalExecution;
}

export interface ProposalExecution {
  state: "in_progress" | "applied" | "failed" | "refused" | "uncertain";
  attempts: number;
  owner?: string;
  leaseUntilMs?: number;
  startedAt?: string;
  updatedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  qboEntityType?: string;
  qboEntityId?: string;
  adopted?: boolean;
}

interface ApplyClaim {
  proposal: ProposalDoc;
  owner: string;
  leaseUntilMs: number;
}

function proposalRef(proposalId: string) {
  return getFirebaseAdminDb()
    .collection(QBO_ACCOUNTING_PROPOSALS_COLLECTION)
    .doc(proposalId);
}

function appendAudit(
  data: ProposalDoc,
  entry: { at: string; actor: string; note: string }
) {
  const trail = Array.isArray(data.auditTrail) ? data.auditTrail : [];
  return [...trail, entry].slice(-20);
}

// Phase 1 — claim. Reads the stored proposal inside a transaction and
// transitions execution.state to in_progress when every precondition
// holds. Returns the apply outcome when claiming itself answers the
// request (already applied, live lease elsewhere, precondition).
async function claimProposal(
  proposalId: string,
  environment: QboEnvironment,
  cutover: string,
  actorLabel: string,
  auto: boolean
): Promise<{ claim?: ApplyClaim; early?: ProposalApplyOutcome }> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const owner = randomUUID();
  const leaseUntilMs = nowMs + EXECUTION_LEASE_MS;
  const ref = proposalRef(proposalId);

  return getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { early: { outcome: "missing" as const } };
    const data = snap.data() as ProposalDoc;
    if (data.environment !== environment) {
      return { early: { outcome: "missing" as const } };
    }
    const execution = data.execution;

    if (data.status === "applied") {
      return {
        early: {
          outcome: "already_applied" as const,
          qboEntityId: execution?.qboEntityId,
        },
      };
    }
    if (
      execution?.state === "in_progress" &&
      typeof execution.leaseUntilMs === "number" &&
      execution.leaseUntilMs > nowMs &&
      execution.owner !== owner
    ) {
      return { early: { outcome: "in_progress" as const } };
    }
    // Automatic mode may self-approve a `proposed` entry whose evidence
    // tier qualifies (`autoEligible` — verified identifier chains and
    // fully-identified, fully-in-scope aggregates). The system decision
    // is recorded with the same fingerprint binding a human's would get.
    let autoApproved = false;
    if (
      data.status === "proposed" &&
      auto &&
      data.autoEligible === true &&
      data.materialFingerprint
    ) {
      autoApproved = true;
    }
    if (data.status !== "approved" && !autoApproved) {
      return {
        early: {
          outcome: "refused" as const,
          reason: `proposal_not_approved (status ${data.status})`,
        },
      };
    }
    if (
      !data.materialFingerprint ||
      (!autoApproved &&
        data.decision?.fingerprint !== data.materialFingerprint)
    ) {
      return {
        early: {
          outcome: "refused" as const,
          reason:
            "approval_fingerprint_mismatch — the stored approval does not bind to the current material facts",
        },
      };
    }
    if (!data.accountingDate || data.accountingDate < cutover) {
      return {
        early: {
          outcome: "refused" as const,
          reason: "pre_cutover — the accounting date precedes the cutover",
        },
      };
    }

    tx.update(ref, {
      ...(autoApproved
        ? (() => {
            const autoDecision = {
              action: "approve" as const,
              actorUid: "automation",
              at: nowIso,
              note: "auto-approved — automatic mode, verified evidence",
              fingerprint: data.materialFingerprint ?? "",
            };
            return {
              status: "approved",
              decision: autoDecision,
              decisions: [
                ...(Array.isArray(data.decisions) ? data.decisions : []),
                autoDecision,
              ].slice(-20),
            };
          })()
        : {}),
      execution: {
        state: "in_progress",
        attempts: (execution?.attempts ?? 0) + 1,
        owner,
        leaseUntilMs,
        startedAt: nowIso,
        updatedAt: nowIso,
      },
      auditTrail: appendAudit(data, {
        at: nowIso,
        actor: actorLabel,
        note:
          (autoApproved ? "auto-approved (automatic mode) — " : "") +
          `execution attempt ${(execution?.attempts ?? 0) + 1} started`,
      }),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { claim: { proposal: data, owner, leaseUntilMs } };
  });
}

// Phase 3 — commit the outcome. Only the claim owner may write back, so
// an expired attempt can never overwrite a successor's state.
async function commitOutcome(
  proposalId: string,
  claim: ApplyClaim,
  actorLabel: string,
  result:
    | { state: "applied"; entityType: QboWrittenEntityType; entityId: string; adopted: boolean }
    | { state: "failed" | "refused" | "uncertain"; code: string; message: string }
): Promise<void> {
  const nowIso = new Date().toISOString();
  const ref = proposalRef(proposalId);
  await getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data() as ProposalDoc;
    if (data.execution?.owner !== claim.owner) return;

    const base: ProposalExecution = {
      state: result.state,
      attempts: data.execution?.attempts ?? 0,
      startedAt: data.execution?.startedAt,
      updatedAt: nowIso,
    };
    const note =
      result.state === "applied"
        ? `applied to QBO — ${result.entityType} ${result.entityId}` +
          (result.adopted ? " (adopted existing entry)" : "")
        : `execution ${result.state} — ${result.code}: ${result.message}`;

    tx.update(ref, {
      ...(result.state === "applied" ? { status: "applied" } : {}),
      execution:
        result.state === "applied"
          ? {
              ...base,
              qboEntityType: result.entityType,
              qboEntityId: result.entityId,
              adopted: result.adopted,
            }
          : { ...base, errorCode: result.code, errorMessage: result.message },
      auditTrail: appendAudit(data, {
        at: nowIso,
        actor: actorLabel,
        note,
      }),
      ...(result.state === "applied"
        ? { appliedAt: FieldValue.serverTimestamp() }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

// DDB gross-receipt verification for aggregate proposals: every eligible
// DDB-originated line in the payout ledger must already have a synced
// QBO sales-receipt record before fees or the transfer post — otherwise
// the clearing outflows would have no corresponding gross inflow.
async function verifyDdbGrossReceipts(
  proposal: ProposalDoc,
  environment: QboEnvironment
): Promise<string | null> {
  const payoutSnap = await getFirebaseAdminDb()
    .collection(STRIPE_PAYOUTS_COLLECTION)
    .doc(proposal.payoutId)
    .get();
  const lines = Array.isArray(payoutSnap.data()?.lines)
    ? (payoutSnap.data()!.lines as {
        lane?: string;
        scope?: string;
        paymentId?: string;
      }[])
    : [];
  const unposted: string[] = [];
  for (const line of lines) {
    if (line.lane !== "ddb" || line.scope !== "eligible") continue;
    if (!line.paymentId) {
      unposted.push("(unidentified DDB line)");
      continue;
    }
    const syncSnap = await getFirebaseAdminDb()
      .collection(QBO_SYNC_RECORDS_COLLECTION)
      .doc(
        qboSyncIdFor(environment, QBO_STRIPE_PAYMENT_SOURCE_TYPE, line.paymentId)
      )
      .get();
    const record = syncSnap.data() as
      | { status?: string; qboEntityId?: string | null }
      | undefined;
    if (record?.status !== "synced" || !record.qboEntityId) {
      unposted.push(line.paymentId);
    }
  }
  return unposted.length
    ? `ddb_gross_unposted — no synced QBO receipt for: ${unposted.join(", ")}`
    : null;
}

// Provider-side recovery for JournalEntry/Transfer: scan a tight date
// window for an entity carrying this proposal's marker whose account
// legs match the proposal exactly. A hit means a prior attempt's write
// landed — adopt it instead of posting again.
async function recoverWrittenEntity(
  ctx: { environment: QboEnvironment; realmId: string; accessToken: string },
  entityType: "JournalEntry" | "Transfer",
  marker: string,
  proposal: ProposalDoc
): Promise<string | null> {
  const day = 24 * 60 * 60 * 1000;
  const center = Date.parse(`${proposal.accountingDate}T00:00:00Z`);
  const from = new Date(center - RECOVERY_WINDOW_DAYS * day)
    .toISOString()
    .slice(0, 10);
  const to = new Date(center + RECOVERY_WINDOW_DAYS * day)
    .toISOString()
    .slice(0, 10);
  const { rows } = await queryQboReconActivity({
    ...ctx,
    entity: entityType,
    fromDate: from,
    toDate: to,
  });
  const match = rows.find((row) => {
    if (!row.memo?.includes(marker)) return false;
    const dr = row.legs.find(
      (leg) =>
        leg.accountId === proposal.debit.accountId &&
        leg.amountMinor === proposal.amountMinor
    );
    const cr = row.legs.find(
      (leg) =>
        leg.accountId === proposal.credit.accountId &&
        leg.amountMinor === -proposal.amountMinor
    );
    return Boolean(dr && cr);
  });
  return match?.id ?? null;
}

// Is this error a definite provider rejection of the write (safe to mark
// refused/failed) rather than an unknown outcome? Transport failures,
// timeouts, and 5xx are ambiguous — the write may have landed.
function isDefiniteWriteRejection(error: unknown): boolean {
  return (
    error instanceof QboError &&
    (error.kind === "validation" ||
      error.kind === "permission_denied" ||
      error.kind === "rate_limited")
  );
}

interface ProviderCtx {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
}

type ProviderVerdict =
  | { kind: "applied"; entityType: QboWrittenEntityType; entityId: string; adopted: boolean }
  | { kind: "refused"; code: string; message: string }
  | { kind: "failed"; code: string; message: string }
  | { kind: "uncertain"; code: string; message: string };

async function executeMovePayment(
  ctx: ProviderCtx,
  proposal: ProposalDoc
): Promise<ProviderVerdict> {
  const paymentId = proposal.qboRefs.paymentId;
  const clearingId = proposal.debit.accountId;
  if (!paymentId || !clearingId) {
    return {
      kind: "refused",
      code: "proposal_incomplete",
      message: "The proposal lacks a QBO payment id or clearing account.",
    };
  }
  const payment = await fetchQboPaymentById({ ...ctx, paymentId });
  if (!payment) {
    return {
      kind: "refused",
      code: "payment_not_found",
      message: "The QBO payment no longer exists.",
    };
  }
  // Already moved — a prior attempt landed or a human reclassified it.
  if (payment.depositToAccountId === clearingId) {
    return { kind: "applied", entityType: "Payment", entityId: payment.id, adopted: true };
  }
  const uf = await findQboUndepositedFundsAccount(ctx);
  if (!uf) {
    return {
      kind: "failed",
      code: "undeposited_unresolvable",
      message: "The Undeposited Funds account could not be resolved.",
    };
  }
  if (payment.depositToAccountId !== uf.id) {
    return {
      kind: "refused",
      code: "payment_not_in_undeposited",
      message:
        "The payment is no longer deposited to Undeposited Funds — refusing to move it from an unexpected account.",
    };
  }
  if (payment.totalMinor !== proposal.amountMinor) {
    return {
      kind: "refused",
      code: "payment_amount_changed",
      message: `QBO payment amount ${payment.totalMinor} no longer matches the proposal ${proposal.amountMinor}.`,
    };
  }
  if (
    payment.currency &&
    payment.currency !== proposal.currency.toUpperCase()
  ) {
    return {
      kind: "refused",
      code: "payment_currency_changed",
      message: "The QBO payment currency no longer matches the proposal.",
    };
  }
  try {
    await updateQboPaymentDepositAccount({
      ...ctx,
      paymentId: payment.id,
      syncToken: payment.syncToken,
      depositToAccountId: clearingId,
    });
    return {
      kind: "applied",
      entityType: "Payment",
      entityId: payment.id,
      adopted: false,
    };
  } catch (error) {
    return classifyWriteError(error);
  }
}

async function executeJournalEntry(
  ctx: ProviderCtx,
  proposal: ProposalDoc
): Promise<ProviderVerdict> {
  const feeId = proposal.debit.accountId;
  const clearingId = proposal.credit.accountId;
  if (!feeId || !clearingId) {
    return {
      kind: "refused",
      code: "mapping_incomplete",
      message: "The proposal lacks a fee expense or clearing account id.",
    };
  }
  const grossProblem = await verifyDdbGrossReceipts(
    proposal,
    ctx.environment
  );
  if (grossProblem) {
    return { kind: "refused", code: "ddb_gross_unposted", message: grossProblem };
  }
  const marker = qboFeeEntryMarker(proposal.payoutId);
  const existing = await recoverWrittenEntity(
    ctx,
    "JournalEntry",
    marker,
    proposal
  );
  if (existing) {
    return {
      kind: "applied",
      entityType: "JournalEntry",
      entityId: existing,
      adopted: true,
    };
  }
  try {
    const created = await createQboJournalEntry({
      ...ctx,
      payload: buildQboJournalEntryPayload({
        txnDate: proposal.accountingDate,
        privateNote: `${marker} — Stripe processing fees for payout ${proposal.payoutId}`,
        lines: [
          {
            postingType: "Debit",
            accountId: feeId,
            amountMinor: proposal.amountMinor,
            description: `Stripe processing fees — payout ${proposal.payoutId}`,
          },
          {
            postingType: "Credit",
            accountId: clearingId,
            amountMinor: proposal.amountMinor,
            description: `Stripe processing fees — payout ${proposal.payoutId}`,
          },
        ],
      }),
    });
    return {
      kind: "applied",
      entityType: "JournalEntry",
      entityId: created.id,
      adopted: false,
    };
  } catch (error) {
    return classifyWriteError(error);
  }
}

async function executePayoutTransfer(
  ctx: ProviderCtx,
  proposal: ProposalDoc
): Promise<ProviderVerdict> {
  const payoutAccountId = proposal.debit.accountId;
  const clearingId = proposal.credit.accountId;
  if (!payoutAccountId || !clearingId) {
    return {
      kind: "refused",
      code: "mapping_incomplete",
      message: "The proposal lacks a payout destination or clearing account id.",
    };
  }
  const grossProblem = await verifyDdbGrossReceipts(
    proposal,
    ctx.environment
  );
  if (grossProblem) {
    return { kind: "refused", code: "ddb_gross_unposted", message: grossProblem };
  }
  const marker = qboPayoutTransferMarker(proposal.payoutId);
  const existing = await recoverWrittenEntity(
    ctx,
    "Transfer",
    marker,
    proposal
  );
  if (existing) {
    return {
      kind: "applied",
      entityType: "Transfer",
      entityId: existing,
      adopted: true,
    };
  }
  try {
    const created = await createQboTransfer({
      ...ctx,
      payload: buildQboTransferPayload({
        txnDate: proposal.accountingDate,
        amountMinor: proposal.amountMinor,
        fromAccountId: clearingId,
        toAccountId: payoutAccountId,
        privateNote: `${marker} — Stripe payout ${proposal.payoutId}`,
      }),
    });
    return {
      kind: "applied",
      entityType: "Transfer",
      entityId: created.id,
      adopted: false,
    };
  } catch (error) {
    return classifyWriteError(error);
  }
}

// Errors thrown by the write call itself: a definite rejection (400/403/
// 429) means nothing landed; anything else means the outcome is unknown
// and must be reconciled before a rewrite.
function classifyWriteError(error: unknown): ProviderVerdict {
  if (isDefiniteWriteRejection(error)) {
    const qbo = error as QboError;
    return qbo.kind === "validation"
      ? { kind: "refused", code: qbo.kind, message: qbo.message }
      : { kind: "failed", code: qbo.kind, message: qbo.message };
  }
  return {
    kind: "uncertain",
    code: error instanceof QboError ? error.kind : "unexpected",
    message:
      "The QuickBooks write outcome is unknown — the entry may have been created. Retry reconciles provider-side before writing again.",
  };
}

// Applies one approved proposal to QBO. Called by the admin apply route
// (manual, approval/automatic mode) and by the automatic sweep (PR D).
export async function applyPayoutProposal(input: {
  proposalId: string;
  actor: { uid: string; email?: string };
  /** Internal grant for the automatic-mode sweep — self-approves an
   *  `autoEligible` proposal. Never passed by an admin route. */
  auto?: boolean;
}): Promise<ApplyProposalResult> {
  const proposalId = input.proposalId.trim();
  if (!proposalId || proposalId.length > 256) {
    throw new QboError("A valid proposalId is required.", "validation", 400);
  }
  const actorLabel = input.actor.email ?? input.actor.uid;
  const environment = getQboEnvironment();

  const mode = getStripeAccountingMode();
  if (mode === "observe") {
    throw new QboError(
      "Proposal execution requires a non-observe accounting mode — the deployment is in observe mode.",
      "permission_denied",
      409
    );
  }
  const cutover = getStripeAutomationCutover();
  if (!cutover) {
    throw new QboError(
      "No accounting cutover is configured — execution is disabled.",
      "configuration",
      409
    );
  }

  const { claim, early } = await claimProposal(
    proposalId,
    environment,
    cutover,
    actorLabel,
    input.auto === true && mode === "automatic"
  );
  if (early || !claim) {
    return { proposalId, apply: early ?? { outcome: "missing" } };
  }
  const proposal = claim.proposal;

  let verdict: ProviderVerdict;
  try {
    // Guard: never begin a write that could outlive the claim.
    if (Date.now() > claim.leaseUntilMs - MIN_LEASE_BEFORE_WRITE_MS) {
      verdict = {
        kind: "failed",
        code: "lease_expiring",
        message: "The execution claim nearly expired before the write.",
      };
    } else {
      const { accessToken, realmId } = await getQuickBooksAccessToken();
      const ctx: ProviderCtx = { environment, realmId, accessToken };
      verdict =
        proposal.kind === "move_payment_to_clearing"
          ? await executeMovePayment(ctx, proposal)
          : proposal.kind === "stripe_fee_expense"
            ? await executeJournalEntry(ctx, proposal)
            : await executePayoutTransfer(ctx, proposal);
    }
  } catch (error) {
    // Token acquisition or a read-path failure — no provider write was
    // attempted, so a retry is unconditionally safe.
    verdict = {
      kind: "failed",
      code: error instanceof QboError ? error.kind : "unexpected",
      message:
        error instanceof QboError
          ? error.message
          : "The execution failed before reaching QuickBooks.",
    };
    logError("stripe.payout.execute_failed", {
      proposalId,
      code: verdict.code,
    });
  }

  if (verdict.kind === "applied") {
    await commitOutcome(proposalId, claim, actorLabel, {
      state: "applied",
      entityType: verdict.entityType,
      entityId: verdict.entityId,
      adopted: verdict.adopted,
    });
    logInfo("stripe.payout.proposal_applied", {
      proposalId,
      entityType: verdict.entityType,
      adopted: verdict.adopted,
    });
    return {
      proposalId,
      apply: {
        outcome: "applied",
        qboEntityType: verdict.entityType,
        qboEntityId: verdict.entityId,
        adopted: verdict.adopted,
      },
    };
  }

  const state =
    verdict.kind === "uncertain"
      ? "uncertain"
      : verdict.kind === "refused"
        ? "refused"
        : "failed";
  await commitOutcome(proposalId, claim, actorLabel, {
    state,
    code: verdict.code,
    message: verdict.message,
  });
  if (verdict.kind === "uncertain" || verdict.kind === "failed") {
    logError("stripe.payout.execute_outcome", {
      proposalId,
      outcome: state,
      code: verdict.code,
    });
  }
  return {
    proposalId,
    apply:
      verdict.kind === "uncertain"
        ? { outcome: "uncertain", message: verdict.message }
        : verdict.kind === "refused"
          ? { outcome: "refused", reason: `${verdict.code} — ${verdict.message}` }
          : { outcome: "failed", reason: `${verdict.code} — ${verdict.message}` },
  };
}
