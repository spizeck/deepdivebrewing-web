"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRightLeft,
  CalendarClock,
  Flag,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  Sparkles,
  UserRound,
  type LucideIcon,
} from "lucide-react";
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
import {
  normalizePhoneNumber,
  telHref,
  whatsappHref,
} from "@/lib/phone";
import {
  tradeLeadIslandLabel,
  TRADE_LEAD_ISLANDS,
  TRADE_VENUE_TYPES,
} from "@/lib/trade-leads-common";
import {
  classifyFollowUp,
  describeTradeLeadActivity,
  followUpDayDelta,
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
import {
  TRADE_EMAIL_BODY_MAX,
  TRADE_EMAIL_SUBJECT_MAX,
  type TradeLeadCommunicationView,
} from "@/lib/trade-leads-email-common";

// Input/select borders use ink at 50% so every form control boundary is
// visible against the paper background (WCAG 1.4.11 non-text contrast).
const fieldClass = "w-full rounded-md border border-ink/50 px-3 py-2";
// Denser variant for the left-rail filters.
const filterFieldClass =
  "w-full rounded-md border border-ink/50 px-2.5 py-1.5 text-sm";
// Small uppercase labels group read-only context vs. editable controls.
const sectionLabelClass =
  "text-xs font-medium uppercase tracking-wide text-muted-foreground";

type StatusFilter = "all" | TradeLeadStatus;
type FollowUpFilter = "all" | FollowUpState;
// "unset" finds leads with no island recorded — pre-#152 records included.
type IslandFilter = "all" | "unset" | string;
type SortMode = "newest" | "oldest" | "follow_up";

interface LeadDetail {
  lead: TradeLeadView;
  activities: TradeLeadActivityView[];
  communications: TradeLeadCommunicationView[];
}

const EMPTY_LEAD_FORM = {
  businessName: "",
  contactName: "",
  email: "",
  phoneOrWhatsapp: "",
  venueType: "",
  island: "",
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

function FollowUpBadge({
  lead,
  showEmpty = false,
}: {
  lead: TradeLeadView;
  showEmpty?: boolean;
}) {
  const delta = followUpDayDelta(lead.nextFollowUpAt, lead.status);
  if (delta === null) {
    return showEmpty ? (
      <span className="text-xs text-muted-foreground">No follow-up</span>
    ) : null;
  }
  if (delta < 0) {
    return (
      <Badge variant="outline" className="border-ember/40 bg-ember/10 text-ember">
        {delta === -1 ? "Overdue" : `Overdue by ${-delta} days`}
      </Badge>
    );
  }
  if (delta === 0) {
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
    <Badge variant="outline">Due {formatAdminDate(lead.nextFollowUpAt)}</Badge>
  );
}

// Timeline type → icon + tint. Restrained accents: notes read as the
// human-authored entries, system entries stay muted.
const ACTIVITY_ICON: Record<
  string,
  { icon: LucideIcon; className: string }
> = {
  note: { icon: MessageSquare, className: "text-ocean" },
  lead_created: { icon: Sparkles, className: "text-moss" },
  status_changed: { icon: ArrowRightLeft, className: "text-ink" },
  owner_changed: { icon: UserRound, className: "text-ocean" },
  island_changed: { icon: MapPin, className: "text-ocean" },
  follow_up_set: { icon: CalendarClock, className: "text-amber-700" },
  follow_up_changed: { icon: CalendarClock, className: "text-amber-700" },
  follow_up_cleared: { icon: CalendarClock, className: "text-amber-700" },
  outcome_changed: { icon: Flag, className: "text-moss" },
  communication: { icon: Mail, className: "text-muted-foreground" },
};
const DEFAULT_ACTIVITY_ICON = {
  icon: MessageSquare,
  className: "text-muted-foreground",
};

// Compact island chip for list rows and the detail header. Missing islands
// (all pre-#152 leads) render a muted "not set" marker rather than being
// silently filed under an island.
function IslandBadge({ island }: { island?: string }) {
  if (!island) {
    return (
      <Badge
        variant="outline"
        className="border-dashed text-muted-foreground"
      >
        No island
      </Badge>
    );
  }
  return <Badge variant="outline">{tradeLeadIslandLabel(island)}</Badge>;
}

// Live delivery badge for an outbound email — read from the communication
// record (provider callbacks update it) rather than the activity snapshot.
const DELIVERY_BADGE: Record<
  string,
  { label: string; className: string }
> = {
  queued: { label: "Queued", className: "text-muted-foreground" },
  sent: { label: "Sent", className: "text-ocean" },
  delivery_delayed: {
    label: "Delayed",
    className: "border-amber-500/40 bg-amber-100/70 text-amber-900",
  },
  delivered: {
    label: "Delivered",
    className: "border-moss/40 bg-moss/10 text-moss",
  },
  bounced: {
    label: "Bounced",
    className: "border-ember/40 bg-ember/10 text-ember",
  },
  complained: {
    label: "Complaint",
    className: "border-ember/40 bg-ember/10 text-ember",
  },
  failed: {
    label: "Failed",
    className: "border-ember/40 bg-ember/10 text-ember",
  },
};

function DeliveryBadge({ state }: { state?: string }) {
  const entry = state ? DELIVERY_BADGE[state] : undefined;
  if (!entry) return null;
  return (
    <Badge variant="outline" className={entry.className}>
      {entry.label}
    </Badge>
  );
}

// Pre-fills the composer when replying to an inbound email — keeps an
// existing Re: prefix rather than stacking another one.
function replySubject(subject: string | undefined): string {
  const trimmed = subject?.trim() ?? "";
  if (!trimmed) return "";
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
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
  const [islandFilter, setIslandFilter] = useState<IslandFilter>("all");
  const [followUpFilter, setFollowUpFilter] = useState<FollowUpFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [search, setSearch] = useState("");

  const [saving, setSaving] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [followUpDraft, setFollowUpDraft] = useState("");
  const [outcomeDraft, setOutcomeDraft] = useState("");

  // Email composer (#152). replyToCommunicationId targets the In-Reply-To/
  // References headers at the message being answered.
  const [composerOpen, setComposerOpen] = useState(false);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailReplyToId, setEmailReplyToId] = useState<string | undefined>();
  const [emailError, setEmailError] = useState("");
  // Snapshot of the last failed send. Resubmitting an unchanged draft
  // retries that same communication (same Resend idempotency key), so a
  // send that failed after the provider accepted it can't become two
  // customer emails.
  const [emailRetry, setEmailRetry] = useState<{
    communicationId: string;
    subject: string;
    body: string;
    replyToCommunicationId?: string;
  } | null>(null);
  const [addressCopied, setAddressCopied] = useState(false);

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
        const err = new Error(data.error ?? "Request failed.") as Error & {
          communicationId?: string;
        };
        if (typeof data.communicationId === "string") {
          err.communicationId = data.communicationId;
        }
        throw err;
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
        const data = await apiFetch(
          `/api/admin/trade-leads/${encodeURIComponent(id)}`
        );
        const next = {
          lead: data.lead as TradeLeadView,
          activities: (data.activities as TradeLeadActivityView[]) ?? [],
          communications:
            (data.communications as TradeLeadCommunicationView[]) ?? [],
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
        setComposerOpen(false);
        setEmailError("");
        setEmailRetry(null);
        setAddressCopied(false);
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

  // Clears the selection (mobile "back to list" and any future deselect).
  function closeLead() {
    selectedIdRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
  }

  // Staff notification emails deep-link to /admin/trade?lead=<id>; honor it
  // once the workspace mounts so the link lands on the open lead.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current) return;
    deepLinkHandled.current = true;
    const id = new URLSearchParams(window.location.search).get("lead");
    // Only id-shaped values are followed — a crafted ?lead=../x must not
    // steer the fetch onto another admin route.
    if (id && /^[A-Za-z0-9_-]{1,128}$/.test(id)) void openLead(id);
  }, [openLead]);

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

  async function sendEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!detail || !emailSubject.trim() || !emailBody.trim() || saving) return;
    // An unchanged draft after a send failure retries the same recorded
    // communication; editing the draft makes it a genuinely new message.
    const retryId =
      emailRetry &&
      emailRetry.subject === emailSubject &&
      emailRetry.body === emailBody &&
      emailRetry.replyToCommunicationId === emailReplyToId
        ? emailRetry.communicationId
        : undefined;
    setSaving("email");
    setEmailError("");
    setStatusMessage("");
    try {
      const data = await apiFetch(
        `/api/admin/trade-leads/${detail.lead.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            subject: emailSubject,
            body: emailBody,
            ...(emailReplyToId
              ? { replyToCommunicationId: emailReplyToId }
              : {}),
            ...(retryId ? { retryCommunicationId: retryId } : {}),
          }),
        }
      );
      applyDetail({
        lead: data.lead as TradeLeadView,
        activities: (data.activities as TradeLeadActivityView[]) ?? [],
        communications:
          (data.communications as TradeLeadCommunicationView[]) ?? [],
      });
      setComposerOpen(false);
      setEmailSubject("");
      setEmailBody("");
      setEmailReplyToId(undefined);
      setEmailRetry(null);
      setStatusMessage("Email sent.");
      setStatusIsError(false);
    } catch (error) {
      const failedCommId =
        error instanceof Error
          ? (error as { communicationId?: string }).communicationId
          : undefined;
      if (failedCommId) {
        setEmailRetry({
          communicationId: failedCommId,
          subject: emailSubject,
          body: emailBody,
          replyToCommunicationId: emailReplyToId,
        });
      }
      setEmailError(
        error instanceof Error ? error.message : "Could not send the email."
      );
    } finally {
      setSaving(null);
    }
  }

  // Resend a stuck (queued) or failed outbound message from the timeline.
  // The stored subject/body are resubmitted so the server can verify the
  // payload is identical before replaying the same idempotency key.
  async function retryEmail(comm: TradeLeadCommunicationView) {
    if (!detail || !comm.subject || !comm.textBody || saving) return;
    setSaving(`retry-${comm.id}`);
    setStatusMessage("");
    try {
      const data = await apiFetch(
        `/api/admin/trade-leads/${detail.lead.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            subject: comm.subject,
            body: comm.textBody,
            retryCommunicationId: comm.id,
          }),
        }
      );
      applyDetail({
        lead: data.lead as TradeLeadView,
        activities: (data.activities as TradeLeadActivityView[]) ?? [],
        communications:
          (data.communications as TradeLeadCommunicationView[]) ?? [],
      });
      setStatusMessage("Email sent.");
      setStatusIsError(false);
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : "Could not resend the email."
      );
      setStatusIsError(true);
    } finally {
      setSaving(null);
    }
  }

  // Reply targets an existing communication so the outbound send carries
  // real In-Reply-To/References headers and stays in its thread.
  function openComposer(opts?: {
    subject?: string;
    replyToCommunicationId?: string;
  }) {
    setEmailSubject(opts?.subject ?? "");
    setEmailBody("");
    setEmailReplyToId(opts?.replyToCommunicationId);
    setEmailError("");
    setEmailRetry(null);
    setComposerOpen(true);
  }

  async function copyInboundAddress() {
    const address = detail?.lead.inboundAddress;
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setAddressCopied(true);
    } catch {
      setAddressCopied(false);
    }
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
        communications:
          (data.communications as TradeLeadCommunicationView[]) ?? [],
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
        communications:
          (data.communications as TradeLeadCommunicationView[]) ?? [],
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
      if (islandFilter === "unset" && lead.island) return false;
      if (
        islandFilter !== "all" &&
        islandFilter !== "unset" &&
        lead.island !== islandFilter
      )
        return false;
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
  }, [leads, statusFilter, ownerFilter, typeFilter, islandFilter, followUpFilter, sortMode, search]);

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

  const phone = detail
    ? normalizePhoneNumber(detail.lead.phoneOrWhatsapp)
    : null;
  const communicationsById = new Map(
    (detail?.communications ?? []).map((comm) => [comm.id, comm])
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-stone bg-paper px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Trade Leads</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              <Link href="/admin" className="text-ocean hover:underline">
                Admin dashboard
              </Link>{" "}
              → Trade leads
            </p>
          </div>
          <div className="flex items-center gap-3">
            {!loading && (
              <p className="text-xs text-muted-foreground">
                {counts.fresh} new · {counts.dueToday} due today ·{" "}
                {counts.overdue} overdue
              </p>
            )}
            <Button size="sm" onClick={() => setNewLeadOpen(true)}>New lead</Button>
          </div>
        </div>
        {statusMessage && (
          <p
            role="status"
            className={`mt-2 text-sm ${statusIsError ? "text-ember" : "text-ocean"}`}
          >
            {statusMessage}
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div
          className={`rounded-lg border border-stone bg-paper p-3 ${
            selectedId ? "hidden lg:block" : ""
          }`}
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
            <label className="text-xs">
              <span className="mb-0.5 block font-medium">Search</span>
              <input
                className={filterFieldClass}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Business or contact"
              />
            </label>
            <label className="text-xs">
              <span className="mb-0.5 block font-medium">Status</span>
              <select
                className={filterFieldClass}
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
            <label className="text-xs">
              <span className="mb-0.5 block font-medium">Owner</span>
              <select
                className={filterFieldClass}
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
            <label className="text-xs">
              <span className="mb-0.5 block font-medium">Business type</span>
              <select
                className={filterFieldClass}
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
            <label className="text-xs">
              <span className="mb-0.5 block font-medium">Island</span>
              <select
                className={filterFieldClass}
                value={islandFilter}
                onChange={(e) => setIslandFilter(e.target.value)}
              >
                <option value="all">All islands</option>
                {TRADE_LEAD_ISLANDS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
                <option value="unset">Not set</option>
              </select>
            </label>
            <label className="text-xs">
              <span className="mb-0.5 block font-medium">Follow-up</span>
              <select
                className={filterFieldClass}
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
            <label className="text-xs">
              <span className="mb-0.5 block font-medium">Sort</span>
              <select
                className={filterFieldClass}
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
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              Loading leads...
            </p>
          ) : leads.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No trade leads yet. New website inquiries appear here
              automatically; use New lead to record one by hand.
            </p>
          ) : filtered.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No leads match the current filters.
            </p>
          ) : (
            <ul className="mt-3 space-y-1.5">
              {filtered.map((lead) => (
                <li key={lead.id}>
                  <button
                    type="button"
                    aria-current={selectedId === lead.id}
                    onClick={() => void openLead(lead.id)}
                    className={`w-full rounded-md border px-2.5 py-2 text-left text-sm ${
                      selectedId === lead.id
                        ? "border-ocean/60 bg-ocean/[0.07]"
                        : "border-transparent hover:border-stone hover:bg-stone/25"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">
                        {lead.businessName}
                      </span>
                      <StatusBadge status={lead.status} />
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {lead.contactName || "—"} · {tradeVenueTypeLabel(lead.venueType)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      Owner: {lead.assignedToName ?? "Unassigned"}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <IslandBadge island={lead.island} />
                      <FollowUpBadge lead={lead} />
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Active {formatAdminDate(leadLastActivityIso(lead))} ·
                      Added {formatAdminDate(lead.createdAt)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div
          className={`rounded-lg border border-stone bg-paper p-4 sm:p-5 ${
            selectedId ? "" : "hidden lg:block"
          }`}
        >
          {!selectedId ? (
            <p className="text-sm text-muted-foreground">
              Select a lead from the list to view its details and history.
            </p>
          ) : (
            <>
              <div className="mb-3 lg:hidden">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={closeLead}
                  className="-ml-2"
                >
                  <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
                  All leads
                </Button>
              </div>
              {detailLoading || !detail ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading lead...
                </p>
              ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="text-xl font-semibold leading-tight">
                    {detail.lead.businessName}
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {tradeLeadSourceLabel(detail.lead.source)} ·{" "}
                    {tradeVenueTypeLabel(detail.lead.venueType)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <StatusBadge status={detail.lead.status} />
                  <IslandBadge island={detail.lead.island} />
                </div>
              </div>

              <div className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div>
                  <p className={sectionLabelClass}>Contact</p>
                  <p className="mt-1">
                    {detail.lead.contactName || "—"}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {detail.lead.email && (
                      <a
                        href={`mailto:${detail.lead.email}`}
                        className="inline-flex items-center gap-1.5 break-all text-ocean hover:underline"
                      >
                        <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {detail.lead.email}
                      </a>
                    )}
                    {phone?.display ? (
                      <>
                        {telHref(phone) ? (
                          <a
                            href={telHref(phone)!}
                            className="inline-flex items-center gap-1.5 text-ocean hover:underline"
                          >
                            <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            {phone.display}
                          </a>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            {phone.display}
                          </span>
                        )}
                        {whatsappHref(phone) && (
                          <a
                            href={whatsappHref(phone)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-ocean hover:underline"
                          >
                            <MessageSquare className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            WhatsApp
                          </a>
                        )}
                      </>
                    ) : null}
                  </div>
                </div>
                <div>
                  <p className={sectionLabelClass}>Activity</p>
                  <p className="mt-1 text-muted-foreground">
                    Last activity{" "}
                    {formatAdminDate(leadLastActivityIso(detail.lead))}
                    <br />
                    Created {formatAdminDate(detail.lead.createdAt)}
                    {detail.lead.closedAt && (
                      <>
                        <br />
                        Closed {formatAdminDate(detail.lead.closedAt)}
                      </>
                    )}
                  </p>
                </div>
              </div>

              <div className="rounded-md border border-stone p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className={sectionLabelClass}>Email</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!detail.lead.email || saving !== null}
                    onClick={() =>
                      composerOpen ? setComposerOpen(false) : openComposer()
                    }
                  >
                    {composerOpen ? "Close" : "Email this lead"}
                  </Button>
                </div>
                {!detail.lead.email && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add an email address to the lead before sending.
                  </p>
                )}
                {detail.lead.inboundAddress && (
                  <div className="mt-3 border-t border-stone pt-2">
                    <p className="font-medium">Attach email to this lead</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Forward any email about this customer to the address
                      below and it appears in this lead&apos;s history.
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <code className="rounded bg-stone/40 px-2 py-1 text-xs break-all">
                        {detail.lead.inboundAddress}
                      </code>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => void copyInboundAddress()}
                      >
                        {addressCopied ? "Copied" : "Copy"}
                      </Button>
                    </div>
                  </div>
                )}
                {composerOpen && (
                  <form
                    onSubmit={sendEmail}
                    className="mt-3 space-y-2 border-t border-stone pt-3"
                  >
                    <label className="block">
                      <span className="mb-1 block font-medium">To</span>
                      <input
                        className={fieldClass}
                        value={detail.lead.email}
                        disabled
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block font-medium">Subject</span>
                      <input
                        required
                        className={fieldClass}
                        value={emailSubject}
                        onChange={(e) => setEmailSubject(e.target.value)}
                        maxLength={TRADE_EMAIL_SUBJECT_MAX}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block font-medium">Message</span>
                      <textarea
                        required
                        className={fieldClass}
                        rows={6}
                        value={emailBody}
                        onChange={(e) => setEmailBody(e.target.value)}
                        maxLength={TRADE_EMAIL_BODY_MAX}
                      />
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Replies to this email come back into this lead&apos;s
                      history automatically.
                    </p>
                    {emailError && (
                      <p role="alert" className="text-sm text-ember">
                        {emailError}
                      </p>
                    )}
                    <Button
                      type="submit"
                      size="sm"
                      disabled={
                        saving !== null ||
                        !emailSubject.trim() ||
                        !emailBody.trim()
                      }
                    >
                      {saving === "email" ? "Sending..." : "Send email"}
                    </Button>
                  </form>
                )}
              </div>

              {detail.lead.message && (
                <div>
                  <p className={sectionLabelClass}>Original inquiry</p>
                  <p className="mt-1 whitespace-pre-wrap rounded-md bg-stone/30 p-2.5 text-[13px] text-muted-foreground">
                    {detail.lead.message}
                  </p>
                </div>
              )}

              <div className="rounded-md border border-stone p-3">
                <p className={sectionLabelClass}>Manage</p>
                <div className="mt-2 grid gap-3 sm:grid-cols-3">
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
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">Island</span>
                    <select
                      className={fieldClass}
                      value={detail.lead.island ?? ""}
                      disabled={saving !== null}
                      onChange={(e) =>
                        void patchLead(
                          { island: e.target.value || null },
                          "island"
                        )
                      }
                    >
                      <option value="">Not set</option>
                      {TRADE_LEAD_ISLANDS.map((i) => (
                        <option key={i.value} value={i.value}>
                          {i.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {selectedTerminal ? (
                  <div className="mt-3 flex flex-wrap items-end gap-2">
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
                ) : (
                  <div className="mt-3">
                    <span id="next-follow-up-label" className="mb-1 block text-sm font-medium">
                      Next follow-up
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="date"
                        aria-labelledby="next-follow-up-label"
                        className="rounded-md border border-ink/50 px-2.5 py-1.5 text-sm"
                        value={followUpDraft}
                        disabled={saving !== null}
                        onChange={(e) => setFollowUpDraft(e.target.value)}
                        // Save on blur, not per keystroke: date inputs emit a
                        // change event per segment while typing (year "2026"
                        // passes through "0202", a valid-but-wrong date). An
                        // emptied field does NOT clear; clearing stays
                        // explicit via the Clear button.
                        onBlur={(e) => {
                          const iso = dateInputToIso(e.target.value);
                          if (
                            iso &&
                            e.target.value !==
                              dateToLocalDateInput(detail.lead.nextFollowUpAt)
                          ) {
                            void patchLead({ nextFollowUpAt: iso }, "followup");
                          }
                        }}
                      />
                      <FollowUpBadge lead={detail.lead} showEmpty />
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
                    </div>
                  </div>
                )}
              </div>

              <form onSubmit={addNote} className="text-sm">
                <label className="block">
                  <span className="mb-1 block font-medium">Add a note</span>
                  <textarea
                    className={fieldClass}
                    rows={2}
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="e.g. Spoke on WhatsApp — interested in the Saison"
                    maxLength={2000}
                  />
                </label>
                <Button
                  type="submit"
                  size="sm"
                  className="mt-1.5"
                  disabled={saving !== null || !noteDraft.trim()}
                >
                  {saving === "note" ? "Adding..." : "Add note"}
                </Button>
              </form>

              <div>
                <h3 className={sectionLabelClass}>History</h3>
                {timeline.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    No activity recorded yet.
                  </p>
                ) : (
                  <ol className="mt-2 space-y-3">
                    {timeline.map((activity) => {
                      const iconMeta =
                        ACTIVITY_ICON[activity.type] ?? DEFAULT_ACTIVITY_ICON;
                      const ActivityIcon = iconMeta.icon;
                      const isNote = activity.type === "note";
                      const commId = activity.communication?.communicationId;
                      const comm = commId
                        ? communicationsById.get(commId)
                        : undefined;
                      return (
                        <li key={activity.id} className="flex gap-2.5 text-sm">
                          <ActivityIcon
                            className={`mt-0.5 h-4 w-4 shrink-0 ${iconMeta.className}`}
                            aria-hidden="true"
                          />
                          <div className="min-w-0">
                            <p className="text-xs text-muted-foreground">
                              {formatAdminDateTime(activity.createdAt)}
                              {activity.authorName
                                ? ` · ${activity.authorName}`
                                : ""}
                            </p>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1">
                              <p
                                className={`whitespace-pre-wrap ${
                                  isNote ? "" : "text-muted-foreground"
                                }`}
                              >
                                {isNote
                                  ? activity.body
                                  : describeTradeLeadActivity(activity)}
                              </p>
                              {comm?.direction === "outbound" && (
                                <DeliveryBadge state={comm.deliveryState} />
                              )}
                              {comm?.direction === "outbound" &&
                                (comm.deliveryState === "queued" ||
                                  comm.deliveryState === "failed") &&
                                comm.subject &&
                                comm.textBody && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-xs"
                                    disabled={saving === `retry-${comm.id}`}
                                    onClick={() => retryEmail(comm)}
                                  >
                                    {saving === `retry-${comm.id}`
                                      ? "Resending…"
                                      : "Resend"}
                                  </Button>
                                )}
                              {comm?.direction === "inbound" &&
                                detail.lead.email && (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 px-2 text-xs"
                                    onClick={() =>
                                      openComposer({
                                        subject: replySubject(comm.subject),
                                        replyToCommunicationId: comm.id,
                                      })
                                    }
                                  >
                                    Reply
                                  </Button>
                                )}
                            </div>
                            {comm && (
                              <div className="mt-1 rounded-md border border-stone bg-stone/10 p-2 text-muted-foreground">
                                <p className="text-xs">
                                  {comm.direction === "inbound"
                                    ? `From ${comm.from ?? "unknown sender"}`
                                    : `To ${comm.to.join(", ") || "unknown"}`}
                                  {comm.attachments &&
                                  comm.attachments.length > 0
                                    ? ` · ${comm.attachments.length} attachment${
                                        comm.attachments.length === 1 ? "" : "s"
                                      } (not stored)`
                                    : ""}
                                </p>
                                {comm.textBody && (
                                  <p className="mt-1 whitespace-pre-wrap text-xs">
                                    {comm.textBody}
                                    {comm.truncated ? " …" : ""}
                                  </p>
                                )}
                              </div>
                            )}
                            {!isNote && activity.body && (
                              <p className="mt-0.5 whitespace-pre-wrap">
                                {activity.body}
                              </p>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </div>
              )}
            </>
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
              <span className="mb-1 block font-medium">Island</span>
              <select
                className={fieldClass}
                value={newLeadForm.island}
                onChange={(e) =>
                  setNewLeadForm((p) => ({ ...p, island: e.target.value }))
                }
              >
                <option value="">Not set</option>
                {TRADE_LEAD_ISLANDS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
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
