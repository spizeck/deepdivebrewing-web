"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatAdminDateTime } from "@/lib/admin-format";
import { formatUsdMinor } from "@/lib/payments-common";
import type { AdminPanelUser } from "@/components/admin-access";
import type {
  QboReconFlag,
  QboReconRunView,
} from "@/lib/qbo-recon-common";

// Stripe ⇄ QuickBooks reconciliation panel (issue #181). Read-only
// reporting: it shows the last persisted run and can trigger a fresh
// bounded scan. It never posts, adjusts, or deletes accounting entries —
// fee posting stays a separate, accountant-approved step (design §9).

interface ReconResponse {
  ok?: boolean;
  run?: QboReconRunView | null;
  error?: string;
}

const FLAG_LABELS: Record<QboReconFlag["kind"], string> = {
  unattributed_charge: "Charge — source unresolved",
  unattributed_refund: "Refund — source unresolved",
  missing_charge: "Payment without a Stripe charge",
  missing_refund: "Recorded refund missing in Stripe",
  amount_mismatch: "Amount mismatch",
  currency_mismatch: "Currency mismatch",
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

export function AdminQuickbooksRecon({
  user,
  connected,
}: {
  user: AdminPanelUser;
  connected: boolean;
}) {
  const [run, setRun] = useState<QboReconRunView | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const apiFetch = useCallback(
    async (path: string, init?: RequestInit): Promise<ReconResponse> => {
      const idToken = await user.getIdToken();
      const res = await fetch(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${idToken}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
      });
      const data = (await res.json().catch(() => ({}))) as ReconResponse;
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Request failed.");
      }
      return data;
    },
    [user]
  );

  const loadLatest = useCallback(async (): Promise<void> => {
    try {
      const data = await apiFetch("/api/admin/quickbooks/reconciliation");
      setRun(data.run ?? null);
    } catch {
      setRun(null);
    } finally {
      setInitialLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (!connected) {
      setInitialLoading(false);
      return;
    }
    void loadLatest();
  }, [connected, loadLatest]);

  async function handleRun() {
    setLoading(true);
    setErrorMessage("");
    setStatusMessage("");
    try {
      const body =
        from || to
          ? JSON.stringify({
              ...(from ? { from } : {}),
              ...(to ? { to } : {}),
            })
          : undefined;
      const data = await apiFetch("/api/admin/quickbooks/reconciliation", {
        method: "POST",
        ...(body ? { body } : {}),
      });
      setRun(data.run ?? null);
      setStatusMessage("Reconciliation run complete.");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "The reconciliation run failed."
      );
    } finally {
      setLoading(false);
    }
  }

  if (!connected) return null;

  const totals = run?.totals;

  return (
    <section
      aria-labelledby="qbo-recon-heading"
      className="rounded-lg border border-stone bg-paper p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2
            id="qbo-recon-heading"
            className="text-lg font-semibold tracking-tight"
          >
            Stripe reconciliation
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only comparison of Stripe transaction activity against
            the QuickBooks clearing account. Nothing is posted or changed.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted-foreground">
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="ml-1 rounded-md border border-ink/50 px-2 py-1 text-sm"
            />
          </label>
          <label className="text-xs text-muted-foreground">
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="ml-1 rounded-md border border-ink/50 px-2 py-1 text-sm"
            />
          </label>
          <Button onClick={handleRun} disabled={loading} variant="outline">
            {loading ? "Running…" : "Run reconciliation"}
          </Button>
        </div>
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

      {initialLoading ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          Loading the last reconciliation run…
        </p>
      ) : !run ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No reconciliation run yet. Run one to compare Stripe activity
          against the QuickBooks books.
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          <p className="text-sm text-muted-foreground">
            {run.range.from} – {run.range.to} · ran{" "}
            {formatAdminDateTime(run.ranAt)}
            {run.ranByEmail ? ` by ${run.ranByEmail}` : ""}
          </p>

          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat
              label="Stripe balance (available)"
              value={
                run.stripeAvailableMinor !== undefined
                  ? formatUsdMinor(run.stripeAvailableMinor)
                  : "—"
              }
            />
            <Stat
              label="Stripe balance (pending)"
              value={
                run.stripePendingMinor !== undefined
                  ? formatUsdMinor(run.stripePendingMinor)
                  : "—"
              }
            />
            <Stat
              label="QBO clearing balance"
              value={
                run.qboAvailable &&
                run.qboClearingBalanceMinor !== undefined
                  ? formatUsdMinor(run.qboClearingBalanceMinor)
                  : "—"
              }
            />
            <Stat
              label="Clearing difference"
              value={
                run.clearingDifferenceMinor !== undefined
                  ? formatUsdMinor(run.clearingDifferenceMinor)
                  : "—"
              }
            />
            <Stat
              label="Net movement in range"
              value={formatUsdMinor(run.netMovementMinor)}
            />
            <Stat
              label="Previous clearing balance"
              value={
                run.previousClearingBalanceMinor !== undefined
                  ? formatUsdMinor(run.previousClearingBalanceMinor)
                  : "—"
              }
            />
            <Stat
              label="In-range clearing activity"
              value={
                run.qboClearingActivityMinor !== undefined
                  ? formatUsdMinor(run.qboClearingActivityMinor)
                  : "—"
              }
            />
            <Stat
              label="QBO fee account balance"
              value={
                run.qboFeeBalanceMinor !== undefined
                  ? formatUsdMinor(run.qboFeeBalanceMinor)
                  : "—"
              }
            />
          </dl>

          {!run.qboAvailable && (
            <p role="status" className="text-sm text-ember">
              QuickBooks was not readable during this run — the Stripe
              side reconciled but the ledger comparison is unavailable.
            </p>
          )}

          {totals && (
            <div>
              <h3 className="text-sm font-semibold tracking-tight">
                Stripe transactions in range
              </h3>
              <dl className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <Stat
                  label="DDB charges (gross)"
                  value={`${formatUsdMinor(totals.grossChargesDdbMinor)} · ${totals.chargeCountDdb}`}
                />
                <Stat
                  label="DDB fees"
                  value={formatUsdMinor(totals.feesDdbMinor)}
                />
                <Stat
                  label="DDB refunds"
                  value={`${formatUsdMinor(totals.refundsDdbMinor)} · ${totals.refundCountDdb}`}
                />
                <Stat
                  label="DDB net"
                  value={formatUsdMinor(totals.netDdbMinor)}
                />
                <Stat
                  label="External charges (gross)"
                  value={`${formatUsdMinor(totals.grossChargesExternalMinor)} · ${totals.chargeCountExternal}`}
                />
                <Stat
                  label="External fees"
                  value={formatUsdMinor(totals.feesExternalMinor)}
                />
                <Stat
                  label="External refunds"
                  value={`${formatUsdMinor(totals.refundsExternalMinor)} · ${totals.refundCountExternal}`}
                />
                <Stat
                  label="External net"
                  value={formatUsdMinor(totals.netExternalMinor)}
                />
                <Stat
                  label="Unattributed"
                  value={`${formatUsdMinor(totals.unattributedGrossMinor)} · ${totals.unattributedCount}`}
                />
                <Stat
                  label="Payouts"
                  value={`${formatUsdMinor(totals.payoutNetMinor)} · ${totals.payoutCount}`}
                />
                <Stat
                  label="Other movements"
                  value={`${formatUsdMinor(totals.otherNetMinor)} · ${totals.otherCount}`}
                />
                <Stat
                  label="Transactions examined"
                  value={String(totals.txnCount)}
                />
              </dl>
            </div>
          )}

          {run.flags.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold tracking-tight">
                Findings
              </h3>
              <ul className="mt-2 space-y-2">
                {run.flags.map((flag, index) => (
                  <li
                    key={`${flag.kind}-${flag.ref}-${index}`}
                    className="rounded-md border border-stone px-3 py-2 text-sm"
                  >
                    <Badge variant="outline">
                      {FLAG_LABELS[flag.kind] ?? flag.kind}
                    </Badge>{" "}
                    <span className="text-muted-foreground">
                      {flag.ref}
                      {flag.amountMinor !== undefined
                        ? ` · ${formatUsdMinor(flag.amountMinor)}`
                        : ""}
                    </span>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {flag.detail}
                    </p>
                  </li>
                ))}
              </ul>
              {run.flagsTruncated && (
                <p className="mt-2 text-xs text-muted-foreground">
                  More findings exist than are shown — narrow the range or
                  inspect the flagged objects in the Stripe dashboard.
                </p>
              )}
            </div>
          )}

          {run.qboLedgerItems.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold tracking-tight">
                Existing QuickBooks entries touching watched accounts
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Entries already booking to the clearing or fee accounts —
                review these before any new fee entry is proposed.
              </p>
              <ul className="mt-2 space-y-2">
                {run.qboLedgerItems.map((item) => (
                  <li
                    key={`${item.entityType}-${item.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-stone px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-ink">
                        {item.entityType} {item.id}
                      </span>{" "}
                      <span className="text-muted-foreground">
                        {item.txnDate ?? ""}
                        {item.docNumber ? ` · ${item.docNumber}` : ""}
                      </span>
                      {item.memo && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {item.memo}
                        </p>
                      )}
                    </div>
                    <span className="font-medium text-ink">
                      {formatUsdMinor(item.amountMinor)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(run.stripeScanTruncated ||
            run.paymentsScanTruncated ||
            run.enrichmentTruncated ||
            run.qboActivityTruncated) && (
            <p role="status" className="text-xs text-muted-foreground">
              This run hit a scan bound — results may be partial. Narrow
              the date range for a complete view.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
