"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatAdminDateTime } from "@/lib/admin-format";
import { formatUsdMinor } from "@/lib/payments-common";
import type { AdminPanelUser } from "@/components/admin-access";
import type {
  QboAccountingProposal,
  StripePayoutAutomationView,
  StripePayoutSyncItem,
  StripePayoutSyncSummary,
  StripePayoutView,
} from "@/lib/stripe-payouts-common";

// Stripe payout accounting panel — the payout review surface. In
// observe mode everything shown is computed proposal state and every
// action is read/reprocess only; in approval mode the panel also exposes
// approve/reject and the explicit Apply action. Those controls are
// convenience only — the server enforces the mode and permission on
// every call.

interface PayoutsResponse {
  ok?: boolean;
  view?: StripePayoutAutomationView;
  summary?: StripePayoutSyncSummary;
  error?: string;
}

const withKey = (s: ReadonlySet<string>, key: string) =>
  new Set(s).add(key);
const withoutKey = (s: ReadonlySet<string>, key: string) => {
  const next = new Set(s);
  next.delete(key);
  return next;
};

const LANE_LABELS: Record<string, string> = {
  ddb: "DDB",
  ollie: "Ollie",
  external: "External",
  account_level: "Account-level",
};

const CONFIDENCE_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  confirmed: "default",
  verified: "default",
  suggested: "secondary",
  ambiguous: "destructive",
  unmatched: "outline",
};

// Human-readable labels for the matcher's short evidence codes — the
// codes are the stored vocabulary; the labels explain why a line is
// verified, suggested (review-only), or excluded.
const EVIDENCE_LABELS: Record<string, string> = {
  exact_amount: "exact amount",
  currency_match: "currency match",
  currency_unverified: "currency unverified",
  date_in_window: "date in window",
  date_unverified: "date unverified",
  application_identity: "application identity",
  identity_match: "shared identifier",
  identity_disambiguated: "identifier disambiguated",
  identifier_conflict: "identifier conflict",
  multiple_identity_matches: "multiple identity matches",
  customer_consistent: "customer name consistent",
  customer_mismatch: "customer name differs",
  cardholder_customer_name_differs: "cardholder name differs",
  spreedly_identity: "Spreedly identity verified",
  spreedly_linkage_unverified: "Spreedly linkage unverified",
  identifier_unverified: "Stripe identifier unmatched",
  no_identifier_evidence: "no identifier evidence",
  ollie_reference_only: "Ollie ref only — review-only",
  refund_not_reclassifiable: "refund — not reclassifiable",
  foreign_currency: "foreign currency",
  multiple_candidates: "multiple candidates",
};

const PROPOSAL_LABELS: Record<QboAccountingProposal["kind"], string> = {
  move_payment_to_clearing: "Move payment to Stripe Clearing",
  stripe_fee_expense: "Record Stripe fees",
  payout_transfer: "Payout transfer to bank",
};

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  proposed: "secondary",
  blocked: "destructive",
  approved: "default",
  rejected: "outline",
  applied: "default",
  stale: "outline",
};

function money(line: { amountMinor: number; currency: string }): string {
  // Non-USD lines are formatted with the explicit currency label — never
  // silently as dollars.
  return line.currency === "USD"
    ? formatUsdMinor(line.amountMinor)
    : `${line.amountMinor} ${line.currency}`;
}

// One line of honest reporting per synced payout: "processed" means the
// ledger built — the proposal/cutover counts say what it produced, so a
// fully pre-cutover payout reads as ingested-but-not-proposed rather than
// silently absent.
function syncItemDescription(item: StripePayoutSyncItem): string {
  switch (item.outcome) {
    case "processed": {
      const parts = [`ledger built · ${item.proposals ?? 0} proposals`];
      if ((item.preCutoverLines ?? 0) > 0) {
        parts.push(
          item.eligibleLines === 0
            ? "all movements predate the cutover — reported only"
            : `${item.preCutoverLines} movement(s) predated the cutover`
        );
      }
      return parts.join(" · ");
    }
    case "status_recorded":
      return "status recorded — nothing to reconcile yet";
    case "already_current":
      return "already up to date";
    case "not_found":
      return "not found in this Stripe environment";
    case "lease_lost":
      return "another sync took over — retry when it finishes";
    case "failed":
      return "processing failed — safe to retry";
  }
}

function syncSummaryLine(summary: StripePayoutSyncSummary): string {
  if (summary.scope === "single") {
    return `Payout sync complete — ${summary.items[0] ? syncItemDescription(summary.items[0]) : "done"}.`;
  }
  const parts = [
    `${summary.discovered} found`,
    `${summary.processed} processed`,
    `${summary.statusRecorded} status-only`,
    `${summary.alreadyCurrent} already current`,
  ];
  if (summary.failed) parts.push(`${summary.failed} failed`);
  if (summary.remaining) parts.push(`${summary.remaining} remaining`);
  return `Payout sync complete — ${parts.join(", ")}.`;
}

function ProposalRow({
  proposal,
  decisionsEnabled,
  busy,
  onDecide,
  onApply,
}: {
  proposal: QboAccountingProposal;
  /** Server still gates every action — this only controls visibility. */
  decisionsEnabled: boolean;
  busy: boolean;
  onDecide: (
    proposal: QboAccountingProposal,
    action: "approve" | "reject",
    note?: string,
    confirmQboPaymentId?: string
  ) => void;
  onApply: (proposalId: string) => void;
}) {
  const [note, setNote] = useState("");
  const [confirmPaymentId, setConfirmPaymentId] = useState("");
  const decision = proposal.decision;
  const execution = proposal.execution;
  // A live claim lease means an apply may be posting right now; an
  // expired one means the attempt stalled and a retry is safe. The
  // effect schedules the single re-render that flips the row from
  // executing to retryable the moment the lease lapses.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const until = execution?.leaseUntilMs;
    if (execution?.state !== "in_progress" || typeof until !== "number") {
      return;
    }
    const timer = window.setTimeout(
      () => setNowMs(Date.now()),
      Math.max(0, until - Date.now() + 250)
    );
    return () => window.clearTimeout(timer);
  }, [execution?.state, execution?.leaseUntilMs]);
  const leaseLive = (execution?.leaseUntilMs ?? 0) > nowMs;
  const inFlight = execution?.state === "in_progress" && leaseLive;
  const approvable = decisionsEnabled && proposal.status === "proposed";
  // Reclassifications approve only after the reviewer confirms the exact
  // QBO payment identity — a `suggested` match can never be approved by
  // a bare click.
  const needsPaymentConfirm =
    proposal.kind === "move_payment_to_clearing" &&
    proposal.status === "proposed";
  const paymentIdConfirmed =
    confirmPaymentId.trim().length > 0 &&
    confirmPaymentId.trim() === proposal.qboRefs.paymentId;
  // Rejection is also the "do not post" marker — the server allows it
  // on any live, undecided status, so blocked entries can be dismissed
  // before their mapping lands.
  const rejectable =
    decisionsEnabled &&
    !inFlight &&
    (proposal.status === "proposed" ||
      proposal.status === "approved" ||
      proposal.status === "blocked");
  const applicable = decisionsEnabled && proposal.status === "approved";
  return (
    <li className="rounded-md border border-stone px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Badge variant={STATUS_VARIANT[proposal.status] ?? "outline"}>
            {proposal.status}
          </Badge>{" "}
          {proposal.historical && (
            <Badge variant="secondary">historical · manual only</Badge>
          )}{" "}
          {execution && execution.state !== "applied" && (
            <Badge
              variant={
                execution.state === "uncertain" ||
                execution.state === "failed"
                  ? "destructive"
                  : "outline"
              }
            >
              {execution.state === "in_progress"
                ? leaseLive
                  ? "executing…"
                  : "execution stalled — safe to retry"
                : `execution ${execution.state}`}
            </Badge>
          )}{" "}
          <span className="font-medium text-ink">
            {PROPOSAL_LABELS[proposal.kind] ?? proposal.kind}
          </span>{" "}
          <span className="text-muted-foreground">
            {proposal.accountingDate || "—"} ·{" "}
            {money({ amountMinor: proposal.amountMinor, currency: proposal.currency })}
            {proposal.lineConfidence
              ? ` · ${proposal.lineConfidence} match`
              : ""}
          </span>
        </div>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {proposal.debit.label} → debit · {proposal.credit.label} → credit
        {proposal.qboRefs.paymentId
          ? ` · QBO payment ${proposal.qboRefs.paymentId}`
          : ""}
        {proposal.qboRefs.paymentRef
          ? ` (${proposal.qboRefs.paymentRef})`
          : ""}
        {proposal.stripeRefs.balanceTxnId
          ? ` · stripe txn ${proposal.stripeRefs.balanceTxnId}`
          : ""}
      </p>
      {proposal.evidence.length > 0 && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          Evidence: {proposal.evidence.join(", ")}
        </p>
      )}
      {decision && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {decision.action === "approve" ? "Approved" : "Rejected"} by{" "}
          {decision.actorEmail ?? decision.actorUid} ·{" "}
          {formatAdminDateTime(decision.at)}
          {decision.note ? ` — ${decision.note}` : ""}
        </p>
      )}
      {execution?.qboEntityId && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          Posted as {execution.qboEntityType} {execution.qboEntityId}
          {execution.adopted ? " (existing entry adopted)" : ""}
        </p>
      )}
      {execution?.errorMessage && execution.state !== "applied" && (
        <p className="mt-0.5 text-xs text-ember">
          {execution.errorCode}: {execution.errorMessage}
          {execution.state === "uncertain"
            ? " — the write may have landed; retry reconciles in QuickBooks first."
            : ""}
        </p>
      )}
      {approvable && needsPaymentConfirm && (
        <div className="mt-2 text-xs text-muted-foreground">
          <p className="mb-1">
            QBO Payment ID:{" "}
            <span className="font-mono text-ink">
              {proposal.qboRefs.paymentId ?? "—"}
            </span>
            {proposal.qboRefs.paymentRef ? (
              <>
                {" "}
                · Payment reference:{" "}
                <span className="font-mono">
                  {proposal.qboRefs.paymentRef}
                </span>
              </>
            ) : null}
          </p>
          <label
            htmlFor={`confirm-${proposal.proposalId}`}
            className="mb-1 block"
          >
            Enter QBO Payment ID {proposal.qboRefs.paymentId ?? ""} to
            confirm this payment — the payment reference identifies it in
            QuickBooks but is not the confirmation value.
          </label>
          <input
            id={`confirm-${proposal.proposalId}`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={confirmPaymentId}
            onChange={(e) => setConfirmPaymentId(e.target.value)}
            placeholder="QBO Payment ID"
            aria-label={`Confirm QBO Payment ID ${proposal.qboRefs.paymentId ?? ""} for ${proposal.proposalId}`}
            className="w-40 rounded-md border border-ink/50 px-2 py-1 text-xs"
          />
        </div>
      )}
      {(approvable || rejectable || applicable) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {approvable && (
            <Button
              variant="outline"
              size="sm"
              disabled={
                busy ||
                inFlight ||
                (needsPaymentConfirm && !paymentIdConfirmed)
              }
              onClick={() =>
                onDecide(
                  proposal,
                  "approve",
                  note || undefined,
                  needsPaymentConfirm ? confirmPaymentId.trim() : undefined
                )
              }
            >
              Approve
            </Button>
          )}
          {rejectable && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                onDecide(proposal, "reject", note || undefined)
              }
            >
              {proposal.status === "approved" ? "Withdraw" : "Reject"}
            </Button>
          )}
          {applicable && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || inFlight}
              onClick={() => onApply(proposal.proposalId)}
            >
              {execution?.state === "failed" ||
              execution?.state === "uncertain" ||
              execution?.state === "refused" ||
              (execution?.state === "in_progress" && !leaseLive)
                ? "Retry apply"
                : "Apply to QuickBooks"}
            </Button>
          )}
          {(approvable || rejectable) && (
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Decision note (optional)"
              aria-label={`Decision note for ${proposal.proposalId}`}
              className="w-52 rounded-md border border-ink/50 px-2 py-1 text-xs"
            />
          )}
        </div>
      )}
    </li>
  );
}

function PayoutCard({
  payout,
  proposals,
  decisionsEnabled,
  decisionBusy,
  onDecide,
  onApply,
  onReprocess,
  busy,
}: {
  payout: StripePayoutView;
  proposals: QboAccountingProposal[];
  decisionsEnabled: boolean;
  decisionBusy: ReadonlySet<string>;
  onDecide: (
    proposal: QboAccountingProposal,
    action: "approve" | "reject",
    note?: string,
    confirmQboPaymentId?: string
  ) => void;
  onApply: (proposalId: string) => void;
  onReprocess: (payoutId: string) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const forPayout = proposals.filter((p) => p.payoutId === payout.payoutId);
  return (
    <li className="rounded-md border border-stone px-3 py-2 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
      >
        <span className="min-w-0">
          <span className="font-medium text-ink">{payout.payoutId}</span>{" "}
          <Badge variant="outline">{payout.status}</Badge>{" "}
          <span className="text-muted-foreground">
            {payout.arrivalDate ?? "—"} ·{" "}
            {money({ amountMinor: payout.amountMinor, currency: payout.currency })}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          {payout.matchedPayments} matched · {payout.unmatchedMovements}{" "}
          unmatched · {payout.proposalCount} proposals
          {payout.staleCount > 0
            ? ` (${payout.proposalCount - payout.staleCount} live · ${payout.staleCount} stale)`
            : ""}
          {payout.exceptionsCount > 0
            ? ` · ${payout.exceptionsCount} exceptions`
            : ""}
        </span>
      </button>
      {open && (
        <div className="mt-3 space-y-3 border-t border-stone pt-3">
          <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Gross charges</dt>
              <dd className="font-medium">
                {money({
                  amountMinor: payout.totals.grossChargesMinor,
                  currency: payout.currency,
                })}{" "}
                · {payout.totals.chargeCount}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Stripe fees</dt>
              <dd className="font-medium">
                {money({
                  amountMinor: payout.totals.feesMinor,
                  currency: payout.currency,
                })}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Computed net</dt>
              <dd className="font-medium">
                {money({
                  amountMinor: payout.totals.computedNetMinor,
                  currency: payout.currency,
                })}
                {!payout.totals.balanced ? " (≠ payout)" : ""}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Processed</dt>
              <dd className="font-medium">
                {payout.lastProcessedAt
                  ? formatAdminDateTime(payout.lastProcessedAt)
                  : "pending"}
              </dd>
            </div>
          </dl>

          {payout.lines && payout.lines.length > 0 && (
            <ul className="space-y-1.5">
              {payout.lines.map((line) => (
                <li
                  key={line.txnId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-stone/60 px-2 py-1 text-xs"
                >
                  <span className="min-w-0">
                    <Badge variant="outline">{line.type}</Badge>{" "}
                    <Badge variant="secondary">
                      {LANE_LABELS[line.lane] ?? line.lane}
                    </Badge>{" "}
                    {line.confidence !== "none" && (
                      <Badge
                        variant={
                          CONFIDENCE_VARIANT[line.confidence] ?? "outline"
                        }
                      >
                        {line.confidence}
                      </Badge>
                    )}{" "}
                    {line.reconciled === "applied" && (
                      <Badge variant="secondary">reconciled</Badge>
                    )}
                    {line.reconciled === "unverified" && (
                      <Badge variant="outline">
                        reconciled · unverified
                      </Badge>
                    )}
                    {line.reconciled === "conflict" && (
                      <Badge variant="destructive">
                        reconciliation conflict
                      </Badge>
                    )}{" "}
                    <span className="text-muted-foreground">
                      {line.txnId}
                      {line.scope === "pre_cutover" ? " · pre-cutover" : ""}
                      {line.scope === "foreign_currency"
                        ? " · currency mismatch"
                        : ""}
                      {line.qboPaymentRef ? ` · ${line.qboPaymentRef}` : ""}
                      {line.customerName ? ` · ${line.customerName}` : ""}
                      {line.identityRefs?.length
                        ? ` · id ${line.identityRefs.join(", ")}`
                        : ""}
                    </span>
                    {line.evidence.length > 0 && (
                      <span className="block text-muted-foreground/80">
                        {line.evidence
                          .map((code) => EVIDENCE_LABELS[code] ?? code)
                          .join(" · ")}
                      </span>
                    )}
                  </span>
                  <span className="font-medium">
                    {money({ amountMinor: line.netMinor, currency: line.currency })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {payout.linesTruncated && (
            <p className="text-xs text-muted-foreground">
              This payout has more movements than are stored — inspect the
              remainder in the Stripe dashboard.
            </p>
          )}

          {payout.exceptions && payout.exceptions.length > 0 && (
            <ul className="space-y-1">
              {payout.exceptions.map((exception, index) => (
                <li
                  key={`${exception.code}-${exception.ref}-${index}`}
                  className="rounded border border-ember/40 bg-ember/5 px-2 py-1 text-xs"
                >
                  <span className="font-medium text-ember">
                    {exception.code}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    {exception.ref} — {exception.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {forPayout.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold">Proposals</h4>
              <ul className="mt-1 space-y-1.5">
                {forPayout.map((proposal) => (
                  <ProposalRow
                    key={proposal.proposalId}
                    proposal={proposal}
                    decisionsEnabled={decisionsEnabled}
                    busy={decisionBusy.has(proposal.proposalId)}
                    onDecide={onDecide}
                    onApply={onApply}
                  />
                ))}
              </ul>
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onReprocess(payout.payoutId)}
          >
            {busy ? "Reprocessing…" : "Reprocess ledger"}
          </Button>
        </div>
      )}
    </li>
  );
}

export function AdminQuickbooksPayouts({
  user,
  connected,
}: {
  user: AdminPanelUser;
  connected: boolean;
}) {
  const [view, setView] = useState<StripePayoutAutomationView | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  // Busy state is per-key: overlapping actions on different targets must
  // not clear each other's disabled state when one finishes first.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [syncing, setSyncing] = useState<"recent" | "single" | null>(null);
  const [payoutIdInput, setPayoutIdInput] = useState("");
  const [syncSummary, setSyncSummary] =
    useState<StripePayoutSyncSummary | null>(null);
  const [decisionBusy, setDecisionBusy] = useState<ReadonlySet<string>>(
    new Set()
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  // View responses can return out of order — only the most recently
  // issued request may replace rendered state. A dropped response means
  // the accepted view may predate another request's committed mutation,
  // so when the last pending mutation settles we re-read the server
  // state once rather than trusting what made it back.
  const viewSeqRef = useRef(0);
  const pendingRef = useRef(0);
  const droppedViewRef = useRef(false);
  const applyView = useCallback(
    (seq: number, next: StripePayoutAutomationView | null) => {
      if (seq === viewSeqRef.current) {
        setView(next);
      } else {
        droppedViewRef.current = true;
      }
    },
    []
  );

  const apiFetch = useCallback(
    async (path: string, init?: RequestInit): Promise<PayoutsResponse> => {
      const idToken = await user.getIdToken();
      const res = await fetch(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${idToken}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
      });
      const data = (await res.json().catch(() => ({}))) as PayoutsResponse;
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Request failed.");
      }
      return data;
    },
    [user]
  );

  const load = useCallback(async (): Promise<void> => {
    const seq = ++viewSeqRef.current;
    try {
      const data = await apiFetch("/api/admin/quickbooks/payouts");
      applyView(seq, data.view ?? null);
      setErrorMessage("");
    } catch (error) {
      applyView(seq, null);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Payout accounting state is unavailable."
      );
    } finally {
      setInitialLoading(false);
    }
  }, [apiFetch, applyView]);

  useEffect(() => {
    void load();
  }, [load]);

  // Runs in every mutation's finally — when the last in-flight request
  // settles, refresh once if any response was dropped, so the panel
  // can't stay on a view that predates a committed mutation.
  const finishMutation = () => {
    pendingRef.current -= 1;
    if (pendingRef.current === 0 && droppedViewRef.current) {
      droppedViewRef.current = false;
      void load();
    }
  };

  async function handleReprocess(payoutId: string) {
    const seq = ++viewSeqRef.current;
    pendingRef.current += 1;
    setBusy((s) => withKey(s, payoutId));
    setErrorMessage("");
    setStatusMessage("");
    setSyncSummary(null);
    try {
      const data = await apiFetch("/api/admin/quickbooks/payouts", {
        method: "POST",
        body: JSON.stringify({ payoutId }),
      });
      applyView(seq, data.view ?? null);
      setStatusMessage(`Payout ${payoutId} reprocessed.`);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Reprocess failed."
      );
    } finally {
      setBusy((s) => withoutKey(s, payoutId));
      finishMutation();
    }
  }

  // Shared run for both sync entry points: the server decides the scope
  // from the (optional) payoutId, applies the shared lease, and returns
  // the summary plus a refreshed view.
  async function runSync(scope: "recent" | "single", payoutId?: string) {
    const seq = ++viewSeqRef.current;
    pendingRef.current += 1;
    setSyncing(scope);
    setErrorMessage("");
    setStatusMessage("");
    setSyncSummary(null);
    try {
      const data = await apiFetch("/api/admin/quickbooks/payouts/sync", {
        method: "POST",
        body: JSON.stringify(payoutId ? { payoutId } : {}),
      });
      applyView(seq, data.view ?? null);
      setSyncSummary(data.summary ?? null);
      if (scope === "single") setPayoutIdInput("");
      setStatusMessage(
        data.summary
          ? syncSummaryLine(data.summary)
          : "Payout sync complete."
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "The payout sync failed."
      );
    } finally {
      setSyncing(null);
      finishMutation();
    }
  }

  function handleSyncById() {
    const payoutId = payoutIdInput.trim();
    if (!/^po_[A-Za-z0-9]+$/.test(payoutId)) {
      setErrorMessage("Enter a Stripe payout id (po_…).");
      return;
    }
    void runSync("single", payoutId);
  }

  // Decisions + apply both return a refreshed view — the server remains
  // the authority on every state transition.
  async function handleDecide(
    proposal: QboAccountingProposal,
    action: "approve" | "reject",
    note?: string,
    confirmQboPaymentId?: string
  ) {
    const seq = ++viewSeqRef.current;
    pendingRef.current += 1;
    setDecisionBusy((s) => withKey(s, proposal.proposalId));
    setErrorMessage("");
    setStatusMessage("");
    try {
      const data = await apiFetch(
        "/api/admin/quickbooks/payouts/proposals",
        {
          method: "POST",
          // The fingerprint the reviewer saw — the server compares it
          // against the live proposal so a rebuild between render and
          // click cannot turn the decision into an approval of unseen
          // facts.
          body: JSON.stringify({
            proposalId: proposal.proposalId,
            action,
            note,
            expectedFingerprint: proposal.materialFingerprint ?? "",
            ...(confirmQboPaymentId ? { confirmQboPaymentId } : {}),
          }),
        }
      );
      applyView(seq, data.view ?? null);
      setStatusMessage(
        `Proposal ${action === "approve" ? "approved" : "rejected"}.`
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "The decision failed."
      );
    } finally {
      setDecisionBusy((s) => withoutKey(s, proposal.proposalId));
      finishMutation();
    }
  }

  async function handleApply(proposalId: string) {
    const seq = ++viewSeqRef.current;
    pendingRef.current += 1;
    setDecisionBusy((s) => withKey(s, proposalId));
    setErrorMessage("");
    setStatusMessage("");
    try {
      const data = await apiFetch(
        "/api/admin/quickbooks/payouts/proposals/apply",
        {
          method: "POST",
          body: JSON.stringify({ proposalId }),
        }
      );
      applyView(seq, data.view ?? null);
      const apply = (
        data as { result?: { apply?: { outcome?: string } } }
      ).result?.apply;
      setStatusMessage(
        apply?.outcome === "applied"
          ? "Proposal applied to QuickBooks."
          : apply?.outcome === "already_applied"
            ? "Proposal was already applied."
            : `Apply finished — ${apply?.outcome ?? "unknown outcome"}.`
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "The apply failed."
      );
    } finally {
      setDecisionBusy((s) => withoutKey(s, proposalId));
      finishMutation();
    }
  }

  const awaiting = view?.payouts.filter((p) => !p.lastProcessedAt) ?? [];
  const blocked =
    view?.proposals.filter((p) => p.status === "blocked") ?? [];
  const proposals = view?.proposals ?? [];
  // In-progress executions with a live lease aren't attention items — a
  // stalled one (lease expired) is, so the count re-renders when the
  // next live deadline passes. The effect keys off the next deadline
  // rather than `proposals` so sequential expiries each reschedule.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const nextLeaseUntilMs = proposals.reduce<number | undefined>(
    (earliest, p) => {
      const until = p.execution?.leaseUntilMs;
      if (
        p.execution?.state !== "in_progress" ||
        typeof until !== "number" ||
        until <= nowMs
      ) {
        return earliest;
      }
      return earliest === undefined ? until : Math.min(earliest, until);
    },
    undefined
  );
  useEffect(() => {
    if (nextLeaseUntilMs === undefined) return;
    const timer = window.setTimeout(
      () => setNowMs(Date.now()),
      Math.max(0, nextLeaseUntilMs - Date.now() + 250)
    );
    return () => window.clearTimeout(timer);
  }, [nextLeaseUntilMs]);
  const pendingApproval = proposals.filter(
    (p) => p.status === "proposed"
  ).length;
  const readyToApply = proposals.filter(
    (p) => p.status === "approved"
  ).length;
  const appliedCount = proposals.filter(
    (p) => p.status === "applied"
  ).length;
  const executionAttention = proposals.filter(
    (p) =>
      p.execution &&
      (p.execution.state === "uncertain" ||
        p.execution.state === "failed" ||
        (p.execution.state === "in_progress" &&
          !(
            typeof p.execution.leaseUntilMs === "number" &&
            p.execution.leaseUntilMs > nowMs
          )))
  ).length;
  const decisionsEnabled = view?.writesEnabled === true;

  return (
    <section
      aria-labelledby="payout-automation-heading"
      className="rounded-lg border border-stone bg-paper p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2
            id="payout-automation-heading"
            className="text-lg font-semibold tracking-tight"
          >
            Stripe payout accounting
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Payout ledgers and proposed QuickBooks entries.{" "}
            {!view || view.mode === "observe"
              ? "Automation runs in observe mode — nothing is posted to QuickBooks."
              : view.mode === "automatic"
                ? "Automatic mode — verified entries post to QuickBooks without individual approval; the rest stay review-required."
                : "Approval mode — apply posts approved entries to QuickBooks."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            mode: {view?.mode ?? "observe"}
          </Badge>
          {!view?.writesEnabled && (
            <Badge variant="outline">writes disabled</Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={syncing !== null || busy.size > 0}
            onClick={() => void runSync("recent")}
          >
            {syncing === "recent" ? "Syncing…" : "Sync recent payouts"}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="text-xs text-muted-foreground">
          Payout ID
          <input
            type="text"
            value={payoutIdInput}
            onChange={(e) => setPayoutIdInput(e.target.value)}
            placeholder="po_…"
            spellCheck={false}
            autoComplete="off"
            className="ml-1 w-56 rounded-md border border-ink/50 px-2 py-1 font-mono text-sm"
          />
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={syncing !== null || busy.size > 0 || !payoutIdInput.trim()}
          onClick={handleSyncById}
        >
          {syncing === "single" ? "Syncing…" : "Sync payout by ID"}
        </Button>
      </div>

      {statusMessage && (
        <p role="status" className="mt-3 text-sm text-ocean">
          {statusMessage}
        </p>
      )}
      {errorMessage && (
        <p role="alert" className="mt-3 text-sm text-ember">
          {errorMessage}
        </p>
      )}

      {syncSummary && syncSummary.items.length > 0 && (
        <div className="mt-3 rounded-md border border-stone px-3 py-2 text-sm">
          <ul className="space-y-1">
            {syncSummary.items.map((item) => (
              <li
                key={item.payoutId}
                className="flex flex-wrap items-baseline justify-between gap-2"
              >
                <span className="min-w-0 font-mono text-xs text-muted-foreground">
                  {item.payoutId}
                </span>
                <span
                  className={
                    item.outcome === "failed" ||
                    item.outcome === "not_found" ||
                    item.outcome === "lease_lost"
                      ? "text-xs text-ember"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {syncItemDescription(item)}
                </span>
              </li>
            ))}
          </ul>
          {syncSummary.remaining > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {syncSummary.remaining} payout(s) still need work — run the
              sync again to continue. Every step is idempotent.
            </p>
          )}
          {syncSummary.scanTruncated && (
            <p role="status" className="mt-2 text-xs text-ember">
              Stripe holds more payouts in the lookback window than the
              bounded scan reached — older payouts may still await
              processing.
            </p>
          )}
        </div>
      )}

      {initialLoading ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          Loading payout accounting state…
        </p>
      ) : !view ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Payout accounting state is unavailable.
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Last reconciliation</dt>
              <dd className="font-medium text-ink">
                {view.lastReconAt ? formatAdminDateTime(view.lastReconAt) : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Awaiting approval</dt>
              <dd className="font-medium text-ink">{pendingApproval}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Ready to apply</dt>
              <dd className="font-medium text-ink">{readyToApply}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Applied</dt>
              <dd className="font-medium text-ink">{appliedCount}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Awaiting processing</dt>
              <dd className="font-medium text-ink">{awaiting.length}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Blocked proposals</dt>
              <dd className="font-medium text-ink">{blocked.length}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Execution attention</dt>
              <dd
                className={`font-medium ${executionAttention > 0 ? "text-ember" : "text-ink"}`}
              >
                {executionAttention}
              </dd>
            </div>
          </dl>

          {view.cutover && (
            <p className="text-xs text-muted-foreground">
              Automation cutover: {view.cutover} — earlier transactions are
              reported for review only.
            </p>
          )}
          {!connected && (
            <p role="status" className="text-sm text-ember">
              QuickBooks is not connected — payouts are still ingested, but
              Ollie payment matching and proposals need a live connection.
            </p>
          )}
          {view.qboAvailable === false && connected && (
            <p role="status" className="text-sm text-ember">
              The QuickBooks leg was unavailable for recent payouts —
              matching ran with Stripe data only.
            </p>
          )}

          {view.payouts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No payouts ingested yet. Payout events arrive via the Stripe
              webhook; the daily sweep recovers any missed delivery, and
              Sync recent payouts runs the same recovery on demand.
            </p>
          ) : (
            <ul className="space-y-2">
              {view.payouts.map((payout) => (
                <PayoutCard
                  key={payout.payoutId}
                  payout={payout}
                  proposals={view.proposals}
                  decisionsEnabled={decisionsEnabled}
                  decisionBusy={decisionBusy}
                  onDecide={(id, action, note, confirmQboPaymentId) =>
                    void handleDecide(id, action, note, confirmQboPaymentId)
                  }
                  onApply={(id) => void handleApply(id)}
                  onReprocess={handleReprocess}
                  busy={busy.has(payout.payoutId)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
