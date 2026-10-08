"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AdminPanelUser } from "@/components/admin-access";
import {
  QBO_MAPPING_FIELDS,
  qboMissingMappingFields,
  type QboAccountingMapping,
  type QboAccountingMappingView,
  type QboDiscoveryEntityType,
  type QboEntitySummary,
} from "@/lib/qbo-common";

// Accounting-mapping configuration card (issues #161/#182): the admin
// picks real entities from the connected QuickBooks company so the Sales
// Receipt posting model knows where settled-payment revenue posts. The
// field set is fixed by the model — every field marked required in
// QBO_MAPPING_FIELDS must be selected before a mapping can be saved, and
// save re-validates each id against the live company.

const FIELD_DESCRIPTIONS: Record<keyof QboAccountingMapping, string> = {
  stripeClearingAccountId:
    "Account that collects sales receipts until Stripe payouts reconcile — e.g. “Stripe Balance”. Not the bank account.",
  tourIncomeItemId:
    "Service item for tour sales: brewery tours, additional guests, and private tours.",
  tastingIncomeItemId: "Service item for tour-and-tasting sales.",
  otherIncomeItemId: "Service item for sales that are not tours or tastings.",
  fallbackCustomerId:
    "Customer recorded on every sales receipt — e.g. “Stripe Checkout”. One shared customer; per-customer records are not created.",
  taxCodeId:
    "Leave unset while the tax treatment of tour and tasting sales is being confirmed with the accountant.",
};

const ENTITY_TYPES_NEEDED: QboDiscoveryEntityType[] = Array.from(
  new Set(QBO_MAPPING_FIELDS.map((field) => field.entityType))
);

const fieldClass = "w-full rounded-md border border-ink/50 px-3 py-2 text-sm";

function labelFor(key: keyof QboAccountingMapping): string {
  return QBO_MAPPING_FIELDS.find((field) => field.key === key)?.label ?? key;
}

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

  const missingFields = mapping?.missingFields ?? [];
  const incomplete = Boolean(mapping?.configured && missingFields.length > 0);
  const draftMissing = qboMissingMappingFields(draft);

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
              ? incomplete
                ? "Mapping incomplete — required fields are missing."
                : "Sales receipts post to these QuickBooks entities."
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

      {incomplete && !editing && (
        <p role="status" className="mt-3 text-sm text-ember">
          Missing required fields:{" "}
          {missingFields.map((key) => labelFor(key)).join(", ")}. Sales
          cannot post to QuickBooks until the mapping is complete.
        </p>
      )}

      {connected && !editing && mapping && (
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          {QBO_MAPPING_FIELDS.map(({ key, label, required }) => {
            const value = mapping.mapping?.[key];
            return (
              <div key={key}>
                <dt className="text-muted-foreground">
                  {label}
                  {!required && " (optional)"}
                </dt>
                <dd
                  className={
                    value
                      ? "font-medium text-ink"
                      : required
                        ? "font-medium text-ember"
                        : "font-medium text-muted-foreground"
                  }
                >
                  {value ? nameFor(value) : required ? "Not set — required" : "Not set"}
                </dd>
              </div>
            );
          })}
        </dl>
      )}

      {editing && entities && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Choose the QuickBooks entities that sales receipts post to. All
            fields marked required must be selected before saving.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {QBO_MAPPING_FIELDS.map(({ key, label, entityType, required }) => (
              <label key={key} className="block text-sm">
                <span className="mb-1 block font-medium">
                  {label}{" "}
                  <span className="font-normal text-muted-foreground">
                    {required ? "(required)" : "(optional)"}
                  </span>
                </span>
                <select
                  required={required}
                  className={fieldClass}
                  value={draft[key] ?? ""}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      [key]: e.target.value || undefined,
                    }))
                  }
                >
                  <option value="">
                    {required ? "Select…" : "Not set"}
                  </option>
                  {(entities[entityType] ?? []).map((entity) => (
                    <option
                      key={entity.id}
                      value={entity.id}
                      disabled={!entity.active}
                    >
                      {entityOptionLabel(entity)}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {FIELD_DESCRIPTIONS[key]}
                </span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleSave}
              disabled={busy || draftMissing.length > 0}
            >
              {busy ? "Saving…" : "Save mapping"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setEditing(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            {draftMissing.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Still required:{" "}
                {draftMissing.map((key) => labelFor(key)).join(", ")}.
              </p>
            )}
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
