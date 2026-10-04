"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AdminPanelUser } from "@/components/admin-access";
import type {
  QboAccountingMapping,
  QboAccountingMappingView,
  QboDiscoveryEntityType,
  QboEntitySummary,
} from "@/lib/qbo-common";

// Accounting-mapping configuration card (issue #161): the admin picks real
// entities from the connected QuickBooks company so future Stripe/tour
// revenue knows where to post. No bookkeeping happens here — this is
// configuration for the deferred sync work only.

const FIELD_DEFS: Array<{
  key: keyof QboAccountingMapping;
  label: string;
  entityType: QboDiscoveryEntityType;
}> = [
  {
    key: "stripeClearingAccountId",
    label: "Stripe clearing / deposit account",
    entityType: "account",
  },
  {
    key: "tourIncomeItemId",
    label: "Brewery tour income item",
    entityType: "item",
  },
  {
    key: "tastingIncomeItemId",
    label: "Tasting income item",
    entityType: "item",
  },
  {
    key: "otherIncomeItemId",
    label: "Other income item",
    entityType: "item",
  },
  {
    key: "fallbackCustomerId",
    label: "Fallback customer",
    entityType: "customer",
  },
  {
    key: "taxCodeId",
    label: "Tax code (optional)",
    entityType: "tax-code",
  },
];

const ENTITY_TYPES_NEEDED: QboDiscoveryEntityType[] = [
  "account",
  "item",
  "customer",
  "tax-code",
];

const fieldClass = "w-full rounded-md border border-ink/50 px-3 py-2 text-sm";

interface EntitiesResponse {
  ok?: boolean;
  entities?: QboEntitySummary[];
  error?: string;
}

interface MappingResponse {
  ok?: boolean;
  mapping?: QboAccountingMappingView;
  error?: string;
}

function entityOptionLabel(entity: QboEntitySummary): string {
  const bits = [entity.name];
  if (entity.type) bits.push(`(${entity.type})`);
  if (!entity.active) bits.push("(inactive)");
  return bits.join(" ");
}

export function AdminQuickbooksMapping({
  user,
  connected,
  mapping,
  onSaved,
}: {
  user: AdminPanelUser;
  connected: boolean;
  mapping: QboAccountingMappingView | null;
  onSaved: (mapping: QboAccountingMappingView) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [entities, setEntities] = useState<Record<
    string,
    QboEntitySummary[]
  > | null>(null);
  const [draft, setDraft] = useState<QboAccountingMapping>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const apiFetch = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const idToken = await user.getIdToken();
      const res = await fetch(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${idToken}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
      });
      const data = (await res.json().catch(() => ({}))) as T & {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Request failed.");
      }
      return data;
    },
    [user]
  );

  async function startEditing() {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const loaded: Record<string, QboEntitySummary[]> = {};
      await Promise.all(
        ENTITY_TYPES_NEEDED.map(async (type) => {
          const data = await apiFetch<EntitiesResponse>(
            `/api/admin/quickbooks/entities?type=${type}`
          );
          loaded[type] = data.entities ?? [];
        })
      );
      setEntities(loaded);
      setDraft(mapping?.mapping ?? {});
      setEditing(true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not load QuickBooks entities."
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const data = await apiFetch<MappingResponse>(
        "/api/admin/quickbooks/mapping",
        { method: "PUT", body: JSON.stringify(draft) }
      );
      if (data.mapping) onSaved(data.mapping);
      setEditing(false);
      setMessage("Mapping saved.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the mapping."
      );
    } finally {
      setBusy(false);
    }
  }

  function nameFor(id: string | undefined): string {
    if (!id) return "—";
    return mapping?.entityNames?.[id] ?? id;
  }

  return (
    <section
      aria-label="QuickBooks accounting mapping"
      className="rounded-lg border border-stone bg-paper p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Accounting mapping</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {mapping?.configured
              ? "Revenue postings will use these QuickBooks entities."
              : "Accounting mapping not configured."}
          </p>
        </div>
        {connected && !editing && (
          <Button
            variant="outline"
            size="sm"
            onClick={startEditing}
            disabled={busy}
          >
            {busy
              ? "Loading…"
              : mapping?.configured
                ? "Edit mapping"
                : "Configure mapping"}
          </Button>
        )}
      </div>

      {!connected && (
        <p className="mt-3 text-sm text-muted-foreground">
          Connect QuickBooks to choose where revenue posts.
        </p>
      )}

      {mapping?.configured && mapping.mapping && !editing && (
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          {FIELD_DEFS.map(({ key, label }) =>
            mapping.mapping?.[key] ? (
              <div key={key}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium text-ink">
                  {nameFor(mapping.mapping[key])}
                </dd>
              </div>
            ) : null
          )}
        </dl>
      )}

      {editing && entities && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELD_DEFS.map(({ key, label, entityType }) => (
              <label key={key} className="block text-sm">
                <span className="mb-1 block font-medium">{label}</span>
                <select
                  className={fieldClass}
                  value={draft[key] ?? ""}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      [key]: e.target.value || undefined,
                    }))
                  }
                >
                  <option value="">Not set</option>
                  {(entities[entityType] ?? []).map((entity) => (
                    <option key={entity.id} value={entity.id}>
                      {entityOptionLabel(entity)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleSave} disabled={busy}>
              {busy ? "Saving…" : "Save mapping"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {message && (
        <p role="status" className="mt-3 text-sm text-ocean">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-ember">
          {error}
        </p>
      )}
    </section>
  );
}
