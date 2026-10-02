"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatAdminDate, formatAdminDateTime } from "@/lib/admin-format";
import type { AdminPanelUser } from "@/components/admin-access";
import { TRADE_VENUE_TYPES } from "@/lib/trade-leads-common";
import {
  classifyFollowUp,
  describeTradeLeadActivity,
  MANUAL_LEAD_SOURCES,
  TRADE_LEAD_STATUSES,
  tradeLeadSourceLabel,
  tradeLeadStatusLabel,
  tradeVenueTypeLabel,
  type FollowUpState,
  type TradeLeadActivityView,
  type TradeLeadAssignee,
  type TradeLeadStatus,
  type TradeLeadView,
} from "@/lib/trade-leads-admin-common";

// Input/select borders use ink at 50% so every form control boundary is
// visible against the paper background (WCAG 1.4.11 non-text contrast).
const fieldClass = "w-full rounded-md border border-ink/50 px-3 py-2";

type StatusFilter = "all" | TradeLeadStatus;
type FollowUpFilter = "all" | FollowUpState;
type SortMode = "newest" | "oldest" | "follow_up";

interface LeadDetail {
  lead: TradeLeadView;
  activities: TradeLeadActivityView[];
}

const EMPTY_LEAD_FORM = {
  businessName: "",
  contactName: "",
  email: "",
  phoneOrWhatsapp: "",
  venueType: "",
  source: "",
  message: "",
};

function dateToLocalDateInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// "YYYY-MM-DD" from <input type="date"> → local-midnight instant. Storing the
// instant keeps the picked calendar day intact in the viewer's timezone —
// the date-only string must never go through `new Date(value)` (UTC parse).
function dateInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    d.getFullYear() !== Number(match[1]) ||
    d.getMonth() !== Number(match[2]) - 1 ||
    d.getDate() !== Number(match[3])
  ) {
    return null;
  }
  return d.toISOString();
}

function leadMillis(iso?: string): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// "Last activity" falls back through the chain an older record actually has:
// pre-pipeline leads only carry createdAt/updatedAt.
export function leadLastActivityIso(lead: TradeLeadView): string | undefined {
  return lead.lastActivityAt ?? lead.updatedAt ?? lead.createdAt;
}

const STATUS_BADGE_CLASS: Record<TradeLeadStatus, string> = {
  new: "border-transparent bg-primary text-primary-foreground",
  contacted: "border-transparent bg-secondary text-secondary-foreground",
  follow_up: "border-amber-500/40 bg-amber-100/70 text-amber-900",
  customer: "border-moss/40 bg-moss/10 text-moss",
  closed: "border-border text-muted-foreground",
};

function StatusBadge({ status }: { status: TradeLeadStatus }) {
  return (
    <Badge variant="outline" className={STATUS_BADGE_CLASS[status]}>
      {tradeLeadStatusLabel(status)}
    </Badge>
  );
}

function FollowUpBadge({ lead }: { lead: TradeLeadView }) {
  const state = classifyFollowUp(lead.nextFollowUpAt, lead.status);
  if (state === "none") return null;
  if (state === "overdue") {
    return (
      <Badge variant="outline" className="border-ember/40 bg-ember/10 text-ember">
        Overdue · {formatAdminDate(lead.nextFollowUpAt)}
      </Badge>
    );
  }
  if (state === "due_today") {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/40 bg-amber-100/70 text-amber-900"
      >
        Due today
      </Badge>
    );
  }
  return (
    <Badge variant="outline">{formatAdminDate(lead.nextFollowUpAt)}</Badge>
  );
}

// wa.me accepts digits only; strip formatting from whatever was submitted.
function whatsappDigits(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

export function AdminTradeWorkspace({ user }: { user: AdminPanelUser }) {
  const [leads, setLeads] = useState<TradeLeadView[]>([]);
  const [admins, setAdmins] = useState<TradeLeadAssignee[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusIsError, setStatusIsError] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Synchronous mirror of selectedId — async detail/mutation responses must
  // only paint if they still belong to the currently selected lead. Without
  // this a slow fetch for lead A can overwrite the panel for lead B and a
  // follow-up edit would land on the wrong record.
  const selectedIdRef = useRef<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [followUpFilter, setFollowUpFilter] = useState<FollowUpFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [search, setSearch] = useState("");

  const [saving, setSaving] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [followUpDraft, setFollowUpDraft] = useState("");
  const [outcomeDraft, setOutcomeDraft] = useState("");

  const [newLeadOpen, setNewLeadOpen] = useState(false);
  const [newLeadForm, setNewLeadForm] = useState(EMPTY_LEAD_FORM);
  const [newLeadError, setNewLeadError] = useState("");
  const [creating, setCreating] = useState(false);

  const apiFetch = useCallback(
    async (path: string, init?: RequestInit) => {
      const idToken = await user.getIdToken();
      const res = await fetch(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${idToken}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
      });
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      > & { ok?: boolean; error?: string };
      if (!res.ok || data.ok !== true) {
        throw new Error(data.error ?? "Request failed.");
      }
      return data;
    },
    [user]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch("/api/admin/trade-leads");
      setLeads((data.leads as TradeLeadView[]) ?? []);
      setAdmins((data.admins as TradeLeadAssignee[]) ?? []);
    } catch (error) {
      console.error(error);
      setStatusMessage("Failed to load trade leads.");
      setStatusIsError(true);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const openLead = useCallback(
    async (id: string) => {
      selectedIdRef.current = id;
      setSelectedId(id);
      setDetailLoading(true);
      setDetail(null);
      setNoteDraft("");
      setOutcomeDraft("");
      try {
        const data = await apiFetch(`/api/admin/trade-leads/${id}`);
        const next = {
          lead: data.lead as TradeLeadView,
          activities: (data.activities as TradeLeadActivityView[]) ?? [],
        };
        // The list is shared state — always merge the fresh record so a
        // stale panel can't keep showing outdated values later.
        setLeads((prev) =>
          prev.map((lead) => (lead.id === next.lead.id ? next.lead : lead))
        );
        // Selection moved on while this fetch was in flight — discard the
        // detail (the newer request owns the panel and the loading flag).
        if (selectedIdRef.current !== id) return;
        setDetail(next);
        setFollowUpDraft(dateToLocalDateInput(next.lead.nextFollowUpAt));
        setOutcomeDraft(next.lead.outcome ?? "");
      } catch (error) {
        if (selectedIdRef.current !== id) return;
        console.error(error);
        setStatusMessage("Failed to load the selected lead.");
        setStatusIsError(true);
      } finally {
        if (selectedIdRef.current === id) {
          setDetailLoading(false);
        }
      }
    },
    [apiFetch]
  );

  // Applies the fresh lead + activities a mutation response returns. The
  // list always updates; the detail panel only updates when the mutated
  // lead is still the selected one (a response may land after switching).
  function applyDetail(next: LeadDetail) {
    setLeads((prev) => {
      const exists = prev.some((lead) => lead.id === next.lead.id);
      return exists
        ? prev.map((lead) => (lead.id === next.lead.id ? next.lead : lead))
        : [next.lead, ...prev];
    });
    if (selectedIdRef.current !== next.lead.id) return;
    setDetail(next);
    setFollowUpDraft(dateToLocalDateInput(next.lead.nextFollowUpAt));
    setOutcomeDraft(next.lead.outcome ?? "");
  }

  async function patchLead(
    fields: Record<string, unknown>,
    actionKey: string
  ) {
    if (!detail || saving) return;
    setSaving(actionKey);
    setStatusMessage("");
    try {
      const data = await apiFetch(`/api/admin/trade-leads/${detail.lead.id}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
      });
      applyDetail({
        lead: data.lead as TradeLeadView,
        activities: (data.activities as TradeLeadActivityView[]) ?? [],
      });
      setStatusMessage("Lead updated.");
      setStatusIsError(false);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Update failed."
      );
      setStatusIsError(true);
    } finally {
      setSaving(null);
    }
  }

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || !noteDraft.trim() || saving) return;
    setSaving("note");
    setStatusMessage("");
    try {
      const data = await apiFetch(
        `/api/admin/trade-leads/${detail.lead.id}/activities`,
        { method: "POST", body: JSON.stringify({ note: noteDraft }) }
      );
      applyDetail({
        lead: data.lead as TradeLeadView,
        activities: (data.activities as TradeLeadActivityView[]) ?? [],
      });
      setNoteDraft("");
      setStatusMessage("Note added.");
      setStatusIsError(false);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Could not add the note."
      );
      setStatusIsError(true);
    } finally {
      setSaving(null);
    }
  }

  async function createLead(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    setNewLeadError("");
    try {
      const data = await apiFetch("/api/admin/trade-leads", {
        method: "POST",
        body: JSON.stringify(newLeadForm),
      });
      const lead = data.lead as TradeLeadView | null;
      if (!lead) throw new Error("Lead was created but could not be loaded.");
      setLeads((prev) => [lead, ...prev]);
      setNewLeadOpen(false);
      setNewLeadForm(EMPTY_LEAD_FORM);
      setStatusMessage("Lead created.");
      setStatusIsError(false);
      if (lead?.id) await openLead(lead.id);
    } catch (error) {
      setNewLeadError(
        error instanceof Error ? error.message : "Could not create the lead."
      );
    } finally {
      setCreating(false);
    }
  }

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = leads.filter((lead) => {
      if (statusFilter !== "all" && lead.status !== statusFilter) return false;
      if (ownerFilter === "unassigned" && lead.assignedToUid) return false;
      if (
        ownerFilter !== "all" &&
        ownerFilter !== "unassigned" &&
        lead.assignedToUid !== ownerFilter
      )
        return false;
      if (typeFilter !== "all" && lead.venueType !== typeFilter) return false;
      if (
        followUpFilter !== "all" &&
        classifyFollowUp(lead.nextFollowUpAt, lead.status) !== followUpFilter
      )
        return false;
      if (
        query &&
        !`${lead.businessName} ${lead.contactName}`
          .toLowerCase()
          .includes(query)
      )
        return false;
      return true;
    });
    list.sort((a, b) => {
      if (sortMode === "oldest") {
        return leadMillis(a.createdAt) - leadMillis(b.createdAt);
      }
      if (sortMode === "follow_up") {
        // Soonest first; leads without a follow-up sink to the bottom.
        const av = leadMillis(a.nextFollowUpAt) || Number.MAX_SAFE_INTEGER;
        const bv = leadMillis(b.nextFollowUpAt) || Number.MAX_SAFE_INTEGER;
        return av - bv || leadMillis(b.createdAt) - leadMillis(a.createdAt);
      }
      return leadMillis(b.createdAt) - leadMillis(a.createdAt);
    });
    return list;
  }, [leads, statusFilter, ownerFilter, typeFilter, followUpFilter, sortMode, search]);

  const counts = useMemo(() => {
    let fresh = 0;
    let dueToday = 0;
    let overdue = 0;
    for (const lead of leads) {
      if (lead.status === "new") fresh++;
      const state = classifyFollowUp(lead.nextFollowUpAt, lead.status);
      if (state === "due_today") dueToday++;
      else if (state === "overdue") overdue++;
    }
    return { fresh, dueToday, overdue };
  }, [leads]);

  const selectedTerminal =
    detail && (detail.lead.status === "customer" || detail.lead.status === "closed");

  // The lead's current owner might be a since-disabled admin who is absent
  // from the assignable list — surface them so the select stays truthful.
  const ownerOptions = useMemo(() => {
    const options = [...admins];
    if (
      detail?.lead.assignedToUid &&
      detail.lead.assignedToName &&
      !options.some((a) => a.uid === detail.lead.assignedToUid)
    ) {
      options.push({
        uid: detail.lead.assignedToUid,
        name: detail.lead.assignedToName,
      });
    }
    return options;
  }, [admins, detail]);

  const timeline = useMemo(
    () =>
      detail
        ? [...detail.activities].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
        : [],
    [detail]
  );

  const waDigits = detail ? whatsappDigits(detail.lead.phoneOrWhatsapp) : "";

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-stone bg-paper p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Trade Leads</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              <Link href="/admin" className="text-ocean hover:underline">
                Admin dashboard
              </Link>{" "}
              → Trade leads
            </p>
          </div>
          <div className="flex items-center gap-2">
            {!loading && (
              <p className="text-sm text-muted-foreground">
                {counts.fresh} new · {counts.dueToday} due today ·{" "}
                {counts.overdue} overdue
              </p>
            )}
            <Button onClick={() => setNewLeadOpen(true)}>New lead</Button>
          </div>
        </div>
        {statusMessage && (
          <p
            role="status"
            className={`mt-3 text-sm ${statusIsError ? "text-ember" : "text-ocean"}`}
          >
            {statusMessage}
          </p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="rounded-lg border border-stone bg-paper p-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            <label className="text-sm">
              <span className="mb-1 block font-medium">Search</span>
              <input
                className={fieldClass}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Business or contact"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Status</span>
              <select
                className={fieldClass}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              >
                <option value="all">All statuses</option>
                {TRADE_LEAD_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Owner</span>
              <select
                className={fieldClass}
                value={ownerFilter}
                onChange={(e) => setOwnerFilter(e.target.value)}
              >
                <option value="all">All owners</option>
                <option value="unassigned">Unassigned</option>
                {admins.map((a) => (
                  <option key={a.uid} value={a.uid}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Business type</span>
              <select
                className={fieldClass}
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="all">All types</option>
                {TRADE_VENUE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Follow-up</span>
              <select
                className={fieldClass}
                value={followUpFilter}
                onChange={(e) => setFollowUpFilter(e.target.value as FollowUpFilter)}
              >
                <option value="all">Any follow-up</option>
                <option value="overdue">Overdue</option>
                <option value="due_today">Due today</option>
                <option value="upcoming">Upcoming</option>
                <option value="none">None scheduled</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Sort</span>
              <select
                className={fieldClass}
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as SortMode)}
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="follow_up">Follow-up soonest</option>
              </select>
            </label>
          </div>

          {loading ? (
            <p role="status" className="mt-4 text-sm text-muted-foreground">
              Loading leads...
            </p>
          ) : leads.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              No trade leads yet. New website inquiries appear here
              automatically; use New lead to record one by hand.
            </p>
          ) : filtered.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              No leads match the current filters.
            </p>
          ) : (
            <ul className="mt-4 space-y-1">
              {filtered.map((lead) => (
                <li key={lead.id}>
                  <button
                    type="button"
                    aria-current={selectedId === lead.id}
                    onClick={() => void openLead(lead.id)}
                    className={`w-full rounded-md px-2 py-2 text-left text-sm ${
                      selectedId === lead.id ? "bg-stone/40" : "hover:bg-stone/20"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">
                        {lead.businessName}
                      </span>
                      <StatusBadge status={lead.status} />
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {lead.contactName || "—"} · {tradeVenueTypeLabel(lead.venueType)}
                      {" · "}
                      {lead.assignedToName ?? "Unassigned"}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <FollowUpBadge lead={lead} />
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Last activity {formatAdminDate(leadLastActivityIso(lead))} ·
                      Created {formatAdminDate(lead.createdAt)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border border-stone bg-paper p-5">
          {!selectedId ? (
            <p className="text-sm text-muted-foreground">
              Select a lead from the list to view its details and history.
            </p>
          ) : detailLoading || !detail ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading lead...
            </p>
          ) : (
            <div className="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">
                    {detail.lead.businessName}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {tradeLeadSourceLabel(detail.lead.source)} ·{" "}
                    {tradeVenueTypeLabel(detail.lead.venueType)}
                  </p>
                </div>
                <StatusBadge status={detail.lead.status} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="text-sm">
                  <p className="font-medium">Contact</p>
                  <p className="mt-1 text-muted-foreground">
                    {detail.lead.contactName || "—"}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {detail.lead.email && (
                      <a
                        href={`mailto:${detail.lead.email}`}
                        className="text-ocean hover:underline"
                      >
                        {detail.lead.email}
                      </a>
                    )}
                    {detail.lead.phoneOrWhatsapp && (
                      <>
                        <a
                          href={`tel:${detail.lead.phoneOrWhatsapp.replace(/[^\d+]/g, "")}`}
                          className="text-ocean hover:underline"
                        >
                          {detail.lead.phoneOrWhatsapp}
                        </a>
                        {waDigits && (
                          <a
                            href={`https://wa.me/${waDigits}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-ocean hover:underline"
                          >
                            WhatsApp
                          </a>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <div className="text-sm">
                  <p className="font-medium">Dates</p>
                  <p className="mt-1 text-muted-foreground">
                    Created {formatAdminDateTime(detail.lead.createdAt)}
                    <br />
                    Last activity{" "}
                    {formatAdminDateTime(leadLastActivityIso(detail.lead))}
                    {detail.lead.closedAt && (
                      <>
                        <br />
                        Closed {formatAdminDate(detail.lead.closedAt)}
                      </>
                    )}
                  </p>
                </div>
              </div>

              {detail.lead.message && (
                <div className="text-sm">
                  <p className="font-medium">Original inquiry</p>
                  <p className="mt-1 whitespace-pre-wrap rounded-md border border-stone bg-stone/20 p-3 text-muted-foreground">
                    {detail.lead.message}
                  </p>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Status</span>
                  <select
                    className={fieldClass}
                    value={detail.lead.status}
                    disabled={saving !== null}
                    onChange={(e) =>
                      void patchLead({ status: e.target.value }, "status")
                    }
                  >
                    {TRADE_LEAD_STATUSES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Owner</span>
                  <select
                    className={fieldClass}
                    value={detail.lead.assignedToUid ?? ""}
                    disabled={saving !== null}
                    onChange={(e) =>
                      void patchLead(
                        { assignedToUid: e.target.value || null },
                        "owner"
                      )
                    }
                  >
                    <option value="">Unassigned</option>
                    {ownerOptions.map((a) => (
                      <option key={a.uid} value={a.uid}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {selectedTerminal && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-48 flex-1 text-sm">
                    <span className="mb-1 block font-medium">
                      Outcome (optional)
                    </span>
                    <input
                      className={fieldClass}
                      value={outcomeDraft}
                      onChange={(e) => setOutcomeDraft(e.target.value)}
                      placeholder="e.g. First order placed"
                      maxLength={200}
                    />
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={saving !== null}
                    onClick={() =>
                      void patchLead({ outcome: outcomeDraft }, "outcome")
                    }
                  >
                    Save outcome
                  </Button>
                </div>
              )}

              {!selectedTerminal && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-48 flex-1 text-sm">
                    <span className="mb-1 block font-medium">
                      Next follow-up
                    </span>
                    <input
                      type="date"
                      className={fieldClass}
                      value={followUpDraft}
                      onChange={(e) => setFollowUpDraft(e.target.value)}
                    />
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      saving !== null ||
                      !followUpDraft ||
                      followUpDraft ===
                        dateToLocalDateInput(detail.lead.nextFollowUpAt)
                    }
                    onClick={() => {
                      const iso = dateInputToIso(followUpDraft);
                      if (!iso) {
                        setStatusMessage("Enter a valid follow-up date.");
                        setStatusIsError(true);
                        return;
                      }
                      void patchLead({ nextFollowUpAt: iso }, "followup");
                    }}
                  >
                    Set follow-up
                  </Button>
                  {detail.lead.nextFollowUpAt && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={saving !== null}
                      onClick={() =>
                        void patchLead({ nextFollowUpAt: null }, "followup")
                      }
                    >
                      Clear
                    </Button>
                  )}
                  <FollowUpBadge lead={detail.lead} />
                </div>
              )}

              <form onSubmit={addNote} className="text-sm">
                <label className="block">
                  <span className="mb-1 block font-medium">Add a note</span>
                  <textarea
                    className={fieldClass}
                    rows={3}
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="e.g. Spoke on WhatsApp — interested in the Saison"
                    maxLength={2000}
                  />
                </label>
                <Button
                  type="submit"
                  size="sm"
                  className="mt-2"
                  disabled={saving !== null || !noteDraft.trim()}
                >
                  {saving === "note" ? "Adding..." : "Add note"}
                </Button>
              </form>

              <div>
                <h3 className="text-sm font-semibold">History</h3>
                {timeline.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    No activity recorded yet.
                  </p>
                ) : (
                  <ol className="mt-2 space-y-3 border-l-2 border-stone pl-4">
                    {timeline.map((activity) => (
                      <li key={activity.id} className="text-sm">
                        <p className="text-xs text-muted-foreground">
                          {formatAdminDateTime(activity.createdAt)}
                          {activity.authorName
                            ? ` · ${activity.authorName}`
                            : ""}
                        </p>
                        <p>{describeTradeLeadActivity(activity)}</p>
                        {activity.body && (
                          <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                            {activity.body}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <Dialog open={newLeadOpen} onOpenChange={setNewLeadOpen}>
        <DialogContent>
          <DialogTitle className="text-lg font-semibold">
            New trade lead
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Record a lead that reached you outside the website form — a call,
            a WhatsApp message, a referral, an event.
          </DialogDescription>
          <form onSubmit={createLead} className="mt-4 grid gap-4">
            <label className="text-sm">
              <span className="mb-1 block font-medium">
                Business name
                <span aria-hidden="true" className="text-ember"> *</span>
              </span>
              <input
                required
                className={fieldClass}
                value={newLeadForm.businessName}
                onChange={(e) =>
                  setNewLeadForm((p) => ({ ...p, businessName: e.target.value }))
                }
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block font-medium">Contact name</span>
                <input
                  className={fieldClass}
                  value={newLeadForm.contactName}
                  onChange={(e) =>
                    setNewLeadForm((p) => ({ ...p, contactName: e.target.value }))
                  }
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">
                  How they reached you
                  <span aria-hidden="true" className="text-ember"> *</span>
                </span>
                <select
                  required
                  className={fieldClass}
                  value={newLeadForm.source}
                  onChange={(e) =>
                    setNewLeadForm((p) => ({ ...p, source: e.target.value }))
                  }
                >
                  <option value="" disabled>
                    Select a source
                  </option>
                  {MANUAL_LEAD_SOURCES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block font-medium">Email</span>
                <input
                  type="email"
                  className={fieldClass}
                  value={newLeadForm.email}
                  onChange={(e) =>
                    setNewLeadForm((p) => ({ ...p, email: e.target.value }))
                  }
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block font-medium">Phone / WhatsApp</span>
                <input
                  className={fieldClass}
                  value={newLeadForm.phoneOrWhatsapp}
                  onChange={(e) =>
                    setNewLeadForm((p) => ({
                      ...p,
                      phoneOrWhatsapp: e.target.value,
                    }))
                  }
                />
              </label>
            </div>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Business type</span>
              <select
                className={fieldClass}
                value={newLeadForm.venueType}
                onChange={(e) =>
                  setNewLeadForm((p) => ({ ...p, venueType: e.target.value }))
                }
              >
                <option value="">Other / unknown</option>
                {TRADE_VENUE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Notes</span>
              <textarea
                className={fieldClass}
                rows={3}
                value={newLeadForm.message}
                onChange={(e) =>
                  setNewLeadForm((p) => ({ ...p, message: e.target.value }))
                }
              />
            </label>
            {newLeadError && (
              <p role="alert" className="text-sm text-ember">
                {newLeadError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setNewLeadOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? "Creating..." : "Create lead"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
