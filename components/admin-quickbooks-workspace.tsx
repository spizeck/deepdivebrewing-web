"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatAdminDateTime } from "@/lib/admin-format";
import type { AdminPanelUser } from "@/components/admin-access";
import { AdminQuickbooksMapping } from "@/components/admin-quickbooks-mapping";
import type {
  QboAccountingMappingView,
  QboAdminView,
  QboSyncAdminView,
  QboSyncStatus,
} from "@/lib/qbo-common";

// QuickBooks Online integration surface (issue #161) — a compact status
// card plus the accounting-mapping panel, extended in #183 with the sync
// operations surface (counts, problem records, manual retry). Everything
// shown here is the serialized server view; tokens never reach the
// browser.

interface StatusResponse {
  ok?: boolean;
  connection?: QboAdminView;
  mapping?: QboAccountingMappingView;
  sync?: QboSyncAdminView | null;
  summary?: {
    processed?: number;
    enqueued?: number;
    paused?: boolean;
  };
  result?: { outcome?: string; reason?: string };
  error?: string;
}

// Coarse, safe outcome codes from the OAuth callback redirect — provider
// detail never reaches this URL.
const CALLBACK_MESSAGES: Record<string, string> = {
  denied: "QuickBooks authorization was declined.",
  invalid_callback: "The QuickBooks callback was incomplete — try connecting again.",
  state_invalid: "The sign-in session expired — try connecting again.",
  state_expired: "The sign-in session expired — try connecting again.",
  state_replayed: "That QuickBooks sign-in link was already used — try connecting again.",
  not_configured: "QuickBooks is not configured on this deployment.",
  connect_failed: "The QuickBooks connection could not be completed.",
};

const SYNC_STATUS_LABELS: Record<QboSyncStatus, string> = {
  pending: "Pending",
  syncing: "Syncing",
  synced: "Synced",
  failed: "Failed",
  needs_attention: "Needs attention",
};

function healthLabel(view: QboAdminView): string {
  switch (view.health) {
    case "healthy":
      return "Last check: healthy";
    case "needs_reauthorization":
      return "Last check: reconnection required";
    case "provider_unavailable":
      return "Last check: QuickBooks unavailable";
    default:
      return "No connection check yet";
  }
}

export function AdminQuickbooksWorkspace({
  user,
}: {
  user: AdminPanelUser;
}) {
  const [connection, setConnection] = useState<QboAdminView | null>(null);
  const [mapping, setMapping] = useState<QboAccountingMappingView | null>(
    null
  );
  const [sync, setSync] = useState<QboSyncAdminView | null>(null);
  const [syncError, setSyncError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<
    "connect" | "test" | "disconnect" | "sweep" | null
  >(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const apiFetch = useCallback(
    async (path: string, init?: RequestInit): Promise<StatusResponse> => {
      const idToken = await user.getIdToken();
      const res = await fetch(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${idToken}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
      });
      const data = (await res.json().catch(() => ({}))) as StatusResponse;
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Request failed.");
      }
      return data;
    },
    [user]
  );

  const loadSync = useCallback(async (): Promise<void> => {
    try {
      const data = await apiFetch("/api/admin/quickbooks/sync");
      setSync(data.sync ?? null);
      setSyncError(false);
    } catch {
      setSync(null);
      setSyncError(true);
    }
  }, [apiFetch]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/api/admin/quickbooks/status");
      setConnection(data.connection ?? null);
      setMapping(data.mapping ?? null);
      if (data.connection?.configured) {
        await loadSync();
      } else {
        setSync(null);
        setSyncError(false);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Failed to load the QuickBooks status."
      );
    } finally {
      setLoading(false);
    }
  }, [apiFetch, loadSync]);

  useEffect(() => {
    // Surface the OAuth callback's outcome parameter, then strip it so a
    // refresh doesn't replay the message.
    const params = new URLSearchParams(window.location.search);
    const qbo = params.get("qbo");
    if (qbo === "connected") {
      setStatusMessage("QuickBooks connected successfully.");
    } else if (qbo === "error") {
      const reason = params.get("qbo_reason") ?? "connect_failed";
      setErrorMessage(
        CALLBACK_MESSAGES[reason] ?? CALLBACK_MESSAGES.connect_failed
      );
    }
    if (qbo) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    void load();
  }, [load]);

  async function handleConnect() {
    setBusy("connect");
    setErrorMessage("");
    setStatusMessage("");
    try {
      const data = await apiFetch("/api/admin/quickbooks/connect", {
        method: "POST",
      });
      const url = (data as { authorizationUrl?: string }).authorizationUrl;
      if (typeof url !== "string" || !url) {
        throw new Error("No authorization URL returned.");
      }
      window.location.assign(url);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not start the QuickBooks connection."
      );
      setBusy(null);
    }
  }

  async function handleTest() {
    setBusy("test");
    setErrorMessage("");
    setStatusMessage("");
    try {
      const data = await apiFetch("/api/admin/quickbooks/test", {
        method: "POST",
      });
      setConnection(data.connection ?? null);
      setStatusMessage(
        data.connection?.health === "healthy"
          ? "Connection check succeeded."
          : "Connection check completed — see status below."
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "The connection check could not run."
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect() {
    setBusy("disconnect");
    setErrorMessage("");
    setStatusMessage("");
    try {
      const data = await apiFetch("/api/admin/quickbooks/disconnect", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      });
      setConnection(data.connection ?? null);
      setMapping(null);
      setConfirmDisconnect(false);
      setStatusMessage("QuickBooks disconnected.");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not disconnect QuickBooks."
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleRunSweep() {
    setBusy("sweep");
    setErrorMessage("");
    setStatusMessage("");
    try {
      const data = await apiFetch("/api/admin/quickbooks/sync", {
        method: "POST",
      });
      const summary = data.summary ?? {};
      setStatusMessage(
        summary.paused
          ? "Sync sweep finished — posting is paused until QuickBooks reconnects."
          : `Sync sweep complete — ${summary.processed ?? 0} record(s) processed, ${summary.enqueued ?? 0} enqueued.`
      );
      await loadSync();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "The sync sweep failed."
      );
    } finally {
      setBusy(null);
    }
  }

  async function handleRetry(syncId: string) {
    setRetrying(syncId);
    setErrorMessage("");
    setStatusMessage("");
    try {
      const data = await apiFetch("/api/admin/quickbooks/sync/retry", {
        method: "POST",
        body: JSON.stringify({ syncId }),
      });
      const outcome = data.result?.outcome;
      setStatusMessage(
        outcome === "synced"
          ? "Record synced to QuickBooks."
          : outcome === "paused"
            ? "Record requeued — sync is paused until QuickBooks reconnects."
            : outcome === "failed" || outcome === "needs_attention"
              ? `Record requeued but still needs attention (${data.result?.reason ?? "see status"}).`
              : "Record requeued for sync."
      );
      await loadSync();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "The record could not be requeued."
      );
    } finally {
      setRetrying(null);
    }
  }

  const connected = connection?.status === "connected";
  const needsReconnect = connection?.status === "reauthorization_required";

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-stone bg-paper p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link
              href="/admin"
              className="inline-flex items-center gap-1 text-sm text-ocean hover:underline"
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back to dashboard
            </Link>
            <h1 className="mt-2 text-2xl font-bold tracking-tight">
              QuickBooks Online
            </h1>
          </div>
          {connection && (
            <Badge
              variant="outline"
              className={
                connection.environment === "production"
                  ? "border-ocean/50 text-ocean"
                  : "border-amber-500/50 bg-amber-100/60 text-amber-900"
              }
            >
              {connection.environmentLabel}
            </Badge>
          )}
        </div>

        {loading ? (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            Loading QuickBooks status…
          </p>
        ) : !connection ? (
          <p role="alert" className="mt-4 text-sm text-ember">
            The QuickBooks status could not be loaded.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Badge
                variant={
                  connected
                    ? "secondary"
                    : needsReconnect
                      ? "destructive"
                      : "outline"
                }
              >
                {connection.status === "not_configured"
                  ? "Not configured"
                  : connected
                    ? "Connected"
                    : needsReconnect
                      ? "Reconnect required"
                      : "Not connected"}
              </Badge>
              <p className="text-sm text-muted-foreground">
                {healthLabel(connection)}
                {connection.lastCheckAt
                  ? ` · ${formatAdminDateTime(connection.lastCheckAt)}`
                  : ""}
              </p>
            </div>

            {connection.status === "not_configured" && (
              <p className="text-sm text-muted-foreground">
                QuickBooks credentials are not set on this deployment. See the
                operations guide for the required environment variables.
              </p>
            )}

            {(connected || needsReconnect) && (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Company</dt>
                  <dd className="font-medium text-ink">
                    {connection.companyName ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Company ID</dt>
                  <dd className="font-medium text-ink">
                    {connection.realmIdShort ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Connected</dt>
                  <dd className="font-medium text-ink">
                    {formatAdminDateTime(connection.connectedAt)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Connected by</dt>
                  <dd className="font-medium text-ink">
                    {connection.connectedByEmail ?? "—"}
                  </dd>
                </div>
              </dl>
            )}

            {needsReconnect && (
              <p role="status" className="text-sm text-ember">
                QuickBooks no longer accepts the stored authorization.
                Reconnect to restore the integration.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              {(connection.status === "disconnected" || needsReconnect) &&
                connection.configured && (
                  <Button
                    onClick={handleConnect}
                    disabled={busy !== null}
                    variant="outline"
                  >
                    {busy === "connect"
                      ? "Redirecting…"
                      : needsReconnect
                        ? "Reconnect QuickBooks"
                        : "Connect QuickBooks"}
                  </Button>
                )}
              {needsReconnect && (
                <Button
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={busy !== null}
                  variant="outline"
                >
                  Disconnect
                </Button>
              )}
              {connected && (
                <>
                  <Button
                    onClick={handleTest}
                    disabled={busy !== null}
                    variant="outline"
                  >
                    {busy === "test" ? "Checking…" : "Test connection"}
                  </Button>
                  <Button
                    onClick={handleConnect}
                    disabled={busy !== null}
                    variant="outline"
                  >
                    Reconnect
                  </Button>
                  <Button
                    onClick={() => setConfirmDisconnect(true)}
                    disabled={busy !== null}
                    variant="outline"
                  >
                    Disconnect
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

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
      </div>

      {connection?.configured && (
        <section
          aria-labelledby="qbo-sync-heading"
          className="rounded-lg border border-stone bg-paper p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2
              id="qbo-sync-heading"
              className="text-lg font-semibold tracking-tight"
            >
              Accounting sync
            </h2>
            <Button
              onClick={handleRunSweep}
              disabled={busy !== null || retrying !== null}
              variant="outline"
            >
              {busy === "sweep" ? "Running…" : "Run sync sweep"}
            </Button>
          </div>

          {syncError && (
            <p role="alert" className="mt-3 text-sm text-ember">
              The sync status could not be loaded.
            </p>
          )}

          {sync && (
            <div className="mt-4 space-y-4">
              {sync.paused && (
                <p role="status" className="text-sm text-ember">
                  Sync is paused — reconnect QuickBooks to resume posting.
                  Pending records are preserved and will drain after
                  reconnect.
                </p>
              )}

              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                {(["pending", "syncing", "synced", "failed", "needs_attention"] as const).map(
                  (status) => (
                    <div key={status}>
                      <dt className="text-muted-foreground">
                        {SYNC_STATUS_LABELS[status]}
                      </dt>
                      <dd className="font-medium text-ink">
                        {sync.counts[status]}
                        {sync.truncated && status === "synced" ? "+" : ""}
                      </dd>
                    </div>
                  )
                )}
              </dl>

              {sync.records.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No sync records need attention.
                </p>
              ) : (
                <ul className="space-y-2">
                  {sync.records.map((record) => (
                    <li
                      key={record.syncId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-stone px-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <span className="font-medium text-ink">
                          Payment …{record.sourceId.slice(-8)}
                        </span>{" "}
                        <Badge variant="outline">
                          {SYNC_STATUS_LABELS[record.status]}
                        </Badge>{" "}
                        <span className="text-muted-foreground">
                          {record.lastErrorCode ?? "—"}
                          {record.attempts > 0
                            ? ` · ${record.attempts} attempt${record.attempts === 1 ? "" : "s"}`
                            : ""}
                          {record.status === "failed" && record.nextAttemptAt
                            ? ` · next ${formatAdminDateTime(record.nextAttemptAt)}`
                            : ""}
                        </span>
                        {record.lastErrorMessage && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {record.lastErrorMessage}
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleRetry(record.syncId)}
                        disabled={retrying !== null || busy !== null}
                      >
                        {retrying === record.syncId ? "Retrying…" : "Retry"}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      <AdminQuickbooksMapping
        user={user}
        connected={connected}
        mapping={mapping}
        onSaved={(next) => {
          setMapping(next);
          setConnection((prev) =>
            prev
              ? {
                  ...prev,
                  mappingConfigured:
                    next.configured &&
                    (next.missingFields ?? []).length === 0,
                }
              : prev
          );
        }}
      />

      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent>
          <DialogTitle className="text-lg font-semibold">
            Disconnect QuickBooks?
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-muted-foreground">
            This revokes Deep Dive Brewing&apos;s access to the connected
            QuickBooks company and removes the stored credentials. You can
            reconnect at any time.
          </DialogDescription>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button
              onClick={handleDisconnect}
              disabled={busy !== null}
              variant="destructive"
            >
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </Button>
            <Button
              onClick={() => setConfirmDisconnect(false)}
              variant="outline"
            >
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
