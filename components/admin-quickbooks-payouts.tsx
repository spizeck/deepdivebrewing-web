"use client";

import { useCallback, useEffect, useState } from "react";
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

// Stripe payout accounting panel — the Observe-mode review surface.
// Everything shown is computed proposal state; nothing here posts to
// QuickBooks (no execution path exists in this build). Admins can
// reprocess a payout's ledger when a webhook or sweep missed it, or run
// a bounded sync to recover payouts Stripe never delivered at all.

interface PayoutsResponse {
  ok?: boolean;
  view?: StripePayoutAutomationView;
  summary?: StripePayoutSyncSummary;
  error?: string;
}

const LANE_LABELS: Record<string, string> = {
  ddb: "DDB",
  ollie: "Ollie",
  external: "External",
  account_level: "Account-level",
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

function ProposalRow({ proposal }: { proposal: QboAccountingProposal }) {
  return (
    <li className="rounded-md border border-stone px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Badge variant={STATUS_VARIANT[proposal.status] ?? "outline"}>
            {proposal.status}
          </Badge>{" "}
          <span className="font-medium text-ink">
            {PROPOSAL_LABELS[proposal.kind] ?? proposal.kind}
          </span>{" "}
          <span className="text-muted-foreground">
            {proposal.accountingDate || "—"} ·{" "}
            {money({ amountMinor: proposal.amountMinor, currency: proposal.currency })}
          </span>
        </div>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {proposal.debit.label} → debit · {proposal.credit.label} → credit
        {proposal.qboRefs.paymentRef
          ? ` · ${proposal.qboRefs.paymentRef}`
          : ""}
      </p>
      {proposal.evidence.length > 0 && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          Evidence: {proposal.evidence.join(", ")}
        </p>
      )}
    </li>
  );
}

function PayoutCard({
  payout,
  proposals,
  onReprocess,
  busy,
}: {
  payout: StripePayoutView;
  proposals: QboAccountingProposal[];
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
                    <span className="text-muted-foreground">
                      {line.txnId}
                      {line.scope === "pre_cutover" ? " · pre-cutover" : ""}
                      {line.scope === "foreign_currency"
                        ? " · currency mismatch"
                        : ""}
                      {line.qboPaymentRef ? ` · ${line.qboPaymentRef}` : ""}
                      {line.customerName ? ` · ${line.customerName}` : ""}
                    </span>
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
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<"recent" | "single" | null>(null);
  const [payoutIdInput, setPayoutIdInput] = useState("");
  const [syncSummary, setSyncSummary] =
    useState<StripePayoutSyncSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

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
    try {
      const data = await apiFetch("/api/admin/quickbooks/payouts");
      setView(data.view ?? null);
      setErrorMessage("");
    } catch (error) {
      setView(null);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Payout accounting state is unavailable."
      );
    } finally {
      setInitialLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleReprocess(payoutId: string) {
    setBusy(payoutId);
    setErrorMessage("");
    setStatusMessage("");
    setSyncSummary(null);
    try {
      const data = await apiFetch("/api/admin/quickbooks/payouts", {
        method: "POST",
        body: JSON.stringify({ payoutId }),
      });
      setView(data.view ?? null);
      setStatusMessage(`Payout ${payoutId} reprocessed.`);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Reprocess failed."
      );
    } finally {
      setBusy(null);
    }
  }

  // Shared run for both sync entry points: the server decides the scope
  // from the (optional) payoutId, applies the shared lease, and returns
  // the summary plus a refreshed view.
  async function runSync(scope: "recent" | "single", payoutId?: string) {
    setSyncing(scope);
    setErrorMessage("");
    setStatusMessage("");
    setSyncSummary(null);
    try {
      const data = await apiFetch("/api/admin/quickbooks/payouts/sync", {
        method: "POST",
        body: JSON.stringify(payoutId ? { payoutId } : {}),
      });
      setView(data.view ?? null);
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

  const awaiting = view?.payouts.filter((p) => !p.lastProcessedAt) ?? [];
  const blocked =
    view?.proposals.filter((p) => p.status === "blocked") ?? [];

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
            Payout ledgers and proposed QuickBooks entries. Automation runs
            in observe mode — nothing is posted to QuickBooks.
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
            disabled={syncing !== null || busy !== null}
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
          disabled={syncing !== null || busy !== null || !payoutIdInput.trim()}
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
              <dt className="text-muted-foreground">Payouts processed</dt>
              <dd className="font-medium text-ink">
                {view.payouts.length - awaiting.length}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Awaiting processing</dt>
              <dd className="font-medium text-ink">{awaiting.length}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Blocked proposals</dt>
              <dd className="font-medium text-ink">{blocked.length}</dd>
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
                  onReprocess={handleReprocess}
                  busy={busy === payout.payoutId}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
