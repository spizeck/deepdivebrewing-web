// Shared, dependency-free domain logic for the admin trade-lead pipeline
// (Issue #150). Same split as trade-leads.ts / trade-leads-common.ts: this
// module is pure and safe for client components (no firebase imports);
// lib/trade-leads-admin.ts wires the server-only Admin SDK access.
import { isValidEmail } from "@/lib/email";
import { toIsoString } from "@/lib/admin-serializers";
import {
  timestampMillis,
  TRADE_LEAD_FIELD_LIMITS,
  TRADE_LEAD_SOURCE,
  TRADE_VENUE_TYPES,
} from "@/lib/trade-leads-common";
import { todayCalendarDate, type CalendarDate } from "@/lib/whatsapp";

export const TRADE_LEAD_ACTIVITIES_SUBCOLLECTION = "activities";

// --- Lead lifecycle ---

// Canonical status model. `new` is the value every pre-pipeline lead already
// carries, so existing records need no migration.
export const TRADE_LEAD_STATUSES = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "follow_up", label: "Follow-up" },
  { value: "customer", label: "Customer" },
  { value: "closed", label: "Closed" },
] as const;

export type TradeLeadStatus = (typeof TRADE_LEAD_STATUSES)[number]["value"];

const TRADE_LEAD_STATUS_VALUES: ReadonlySet<string> = new Set(
  TRADE_LEAD_STATUSES.map((s) => s.value)
);

export function isTradeLeadStatus(value: unknown): value is TradeLeadStatus {
  return typeof value === "string" && TRADE_LEAD_STATUS_VALUES.has(value);
}

// Defensive read normalization: a record with a missing or unrecognized
// status (e.g. written outside this codebase) is presented as "new" rather
// than breaking filters. Stored status is never rewritten on read.
export function normalizeTradeLeadStatus(value: unknown): TradeLeadStatus {
  return isTradeLeadStatus(value) ? value : "new";
}

export function tradeLeadStatusLabel(value: unknown): string {
  const status = normalizeTradeLeadStatus(value);
  return (
    TRADE_LEAD_STATUSES.find((s) => s.value === status)?.label ?? status
  );
}

// Terminal statuses: a converted or closed lead never reports an overdue
// follow-up, and entering one clears `nextFollowUpAt` server-side.
export function isTerminalLeadStatus(
  status: TradeLeadStatus
): status is "customer" | "closed" {
  return status === "customer" || status === "closed";
}

// --- Lead source ---

// `trade_form` is written by the public /trade flow (see TRADE_LEAD_SOURCE).
// The remaining values cover leads an admin records by hand.
export const TRADE_LEAD_SOURCES = [
  { value: TRADE_LEAD_SOURCE, label: "Website form" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "phone", label: "Phone call" },
  { value: "in_person", label: "In person" },
  { value: "referral", label: "Referral" },
  { value: "event", label: "Event / trade show" },
  { value: "email", label: "Email" },
  { value: "other", label: "Other" },
] as const;

export type TradeLeadSource = (typeof TRADE_LEAD_SOURCES)[number]["value"];

// Sources an admin may pick when recording a lead manually — `trade_form` is
// reserved for the public submission pipeline.
export const MANUAL_LEAD_SOURCES = TRADE_LEAD_SOURCES.filter(
  (s) => s.value !== TRADE_LEAD_SOURCE
);

const MANUAL_LEAD_SOURCE_VALUES: ReadonlySet<string> = new Set(
  MANUAL_LEAD_SOURCES.map((s) => s.value)
);

export function isManualLeadSource(
  value: unknown
): value is Exclude<TradeLeadSource, typeof TRADE_LEAD_SOURCE> {
  return typeof value === "string" && MANUAL_LEAD_SOURCE_VALUES.has(value);
}

export function tradeLeadSourceLabel(value: unknown): string {
  return (
    TRADE_LEAD_SOURCES.find((s) => s.value === value)?.label ??
    (typeof value === "string" && value ? value : "Unknown")
  );
}

export function tradeVenueTypeLabel(value: unknown): string {
  return (
    TRADE_VENUE_TYPES.find((t) => t.value === value)?.label ??
    (typeof value === "string" && value ? value : "—")
  );
}

// --- Activity / history ---

// Append-only per-lead history stored in the `activities` subcollection.
// `communication` is reserved for a future outbound/inbound messaging
// feature (see TradeLeadCommunication below); no code writes it yet.
export const TRADE_LEAD_ACTIVITY_TYPES = [
  "note",
  "lead_created",
  "status_changed",
  "owner_changed",
  "follow_up_set",
  "follow_up_changed",
  "follow_up_cleared",
  "outcome_changed",
  "communication",
] as const;

export type TradeLeadActivityType =
  (typeof TRADE_LEAD_ACTIVITY_TYPES)[number];

// Channel-agnostic shape for a future messaging feature (email via Resend,
// WhatsApp via a provider integration, …). A sent/received message is stored
// as an activity with `type: "communication"` plus this payload, so it lands
// in the same timeline as notes and status changes. `deliveryState` may be
// updated in place as provider delivery callbacks arrive — the only intended
// exception to append-only history. Not implemented in this issue.
export interface TradeLeadCommunication {
  channel: string;
  direction: "outbound" | "inbound";
  recipient?: string;
  sender?: string;
  subject?: string;
  body?: string;
  sentAt?: string;
  sentByUid?: string;
  sentByName?: string;
  provider?: string;
  providerMessageId?: string;
  deliveryState?: string;
  threadId?: string;
}

// An administrator who can own a lead — the same identity pool as the rest
// of the admin app (active adminUsers), not a separate CRM user table.
export interface TradeLeadAssignee {
  uid: string;
  name: string;
}

export interface TradeLeadRecord {
  businessName: string;
  contactName: string;
  email: string;
  phoneOrWhatsapp: string;
  venueType: string;
  message: string;
  status?: string;
  source?: string;
  assignedToUid?: string;
  assignedToName?: string;
  nextFollowUpAt?: unknown;
  lastActivityAt?: unknown;
  closedAt?: unknown;
  outcome?: string;
  activityCount?: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// Serialized view returned to the admin client: all timestamps as ISO
// strings so nothing Firestore-specific crosses the API boundary.
export interface TradeLeadView {
  id: string;
  businessName: string;
  contactName: string;
  email: string;
  phoneOrWhatsapp: string;
  venueType: string;
  message: string;
  status: TradeLeadStatus;
  source: string;
  assignedToUid?: string;
  assignedToName?: string;
  nextFollowUpAt?: string;
  lastActivityAt?: string;
  closedAt?: string;
  outcome?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TradeLeadActivityRecord {
  type: string;
  seq?: number;
  authorUid?: string;
  authorName?: string;
  body?: string;
  details?: Record<string, unknown>;
  communication?: TradeLeadCommunication;
  createdAt?: unknown;
}

export interface TradeLeadActivityView {
  id: string;
  type: string;
  seq?: number;
  authorUid?: string;
  authorName?: string;
  body?: string;
  details?: Record<string, unknown>;
  communication?: TradeLeadCommunication;
  createdAt?: string;
}

export function serializeTradeLead(
  id: string,
  data: Record<string, unknown>
): TradeLeadView {
  const str = (key: string) => {
    const v = data[key];
    return typeof v === "string" ? v : "";
  };
  const optStr = (key: string) => {
    const v = data[key];
    return typeof v === "string" && v ? v : undefined;
  };
  return {
    id,
    businessName: str("businessName"),
    contactName: str("contactName"),
    email: str("email"),
    phoneOrWhatsapp: str("phoneOrWhatsapp"),
    venueType: str("venueType"),
    message: str("message"),
    status: normalizeTradeLeadStatus(data.status),
    source: str("source") || "unknown",
    assignedToUid: optStr("assignedToUid"),
    assignedToName: optStr("assignedToName"),
    nextFollowUpAt: toIsoString(data.nextFollowUpAt),
    lastActivityAt: toIsoString(data.lastActivityAt),
    closedAt: toIsoString(data.closedAt),
    outcome: optStr("outcome"),
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
  };
}

export function serializeTradeLeadActivity(
  id: string,
  data: Record<string, unknown>
): TradeLeadActivityView {
  const optStr = (key: string) => {
    const v = data[key];
    return typeof v === "string" && v ? v : undefined;
  };
  const details = data.details;
  const communication = data.communication;
  return {
    id,
    type: optStr("type") ?? "note",
    seq: typeof data.seq === "number" ? data.seq : undefined,
    authorUid: optStr("authorUid"),
    authorName: optStr("authorName"),
    body: optStr("body"),
    details:
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : undefined,
    communication:
      communication &&
      typeof communication === "object" &&
      !Array.isArray(communication)
        ? (communication as TradeLeadCommunication)
        : undefined,
    createdAt: toIsoString(data.createdAt),
  };
}

// --- Follow-up classification ---

export type FollowUpState = "overdue" | "due_today" | "upcoming" | "none";

function dayNumber(d: CalendarDate): number {
  return Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;
}

// Follow-ups are stored as instants (the admin's local midnight), but "due
// today"/"overdue" are calendar-day statements. Comparing day numbers in the
// viewer's local timezone — never `new Date("YYYY-MM-DD")` — keeps the
// classification on the date the admin picked.
function calendarDateOf(value: Date): CalendarDate {
  return {
    year: value.getFullYear(),
    month: value.getMonth() + 1,
    day: value.getDate(),
  };
}

export function classifyFollowUp(
  nextFollowUpAt: string | Date | null | undefined,
  status: string,
  today: CalendarDate = todayCalendarDate()
): FollowUpState {
  if (!nextFollowUpAt) return "none";
  // Converted and closed leads are out of the follow-up queue by definition.
  if (isTerminalLeadStatus(normalizeTradeLeadStatus(status))) return "none";
  const date =
    nextFollowUpAt instanceof Date ? nextFollowUpAt : new Date(nextFollowUpAt);
  if (Number.isNaN(date.getTime())) return "none";
  const diff = dayNumber(calendarDateOf(date)) - dayNumber(today);
  if (diff < 0) return "overdue";
  if (diff === 0) return "due_today";
  return "upcoming";
}

// Signed calendar-day delta between the follow-up date and `today` in the
// viewer's local timezone: negative = overdue by N days, 0 = due today,
// positive = N days until due. Returns null when the lead has no active
// follow-up (unset, unparseable, or terminal).
export function followUpDayDelta(
  nextFollowUpAt: string | Date | null | undefined,
  status: string,
  today: CalendarDate = todayCalendarDate()
): number | null {
  if (classifyFollowUp(nextFollowUpAt, status, today) === "none") return null;
  if (nextFollowUpAt == null) return null;
  const date =
    nextFollowUpAt instanceof Date ? nextFollowUpAt : new Date(nextFollowUpAt);
  return dayNumber(calendarDateOf(date)) - dayNumber(today);
}

// --- Admin mutations (pure planning layer) ---

export class TradeLeadError extends Error {
  public readonly clientSafe = true;
  constructor(
    message: string,
    public status: number = 400
  ) {
    super(message);
  }
}

export class TradeLeadNotFoundError extends TradeLeadError {
  constructor() {
    super("Trade lead not found.", 404);
  }
}

// Sentinel marking a field for deletion in a lead-update plan. The
// server-only layer translates it to FieldValue.delete(); this module must
// not import firebase-admin.
export const DELETE_FIELD: unique symbol = Symbol("tradeLeadDeleteField");

export const TRADE_LEAD_NOTE_MAX_LENGTH = 2000;
export const TRADE_LEAD_OUTCOME_MAX_LENGTH = 200;
const FOLLOW_UP_MAX_YEARS_AHEAD = 10;

// Untrusted PATCH body: every key optional; `null` clears a nullable field.
// Presence of at least one recognized key is required.
export interface ParsedLeadPatch {
  status?: TradeLeadStatus;
  assignedToUid?: string | null;
  nextFollowUpAt?: Date | null;
  outcome?: string | null;
}

export function parseLeadPatchBody(
  body: unknown
): { ok: true; patch: ParsedLeadPatch } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body." };
  }
  const raw = body as Record<string, unknown>;
  const patch: ParsedLeadPatch = {};
  let recognized = false;

  if ("status" in raw) {
    recognized = true;
    if (!isTradeLeadStatus(raw.status)) {
      return { ok: false, error: "Unknown lead status." };
    }
    patch.status = raw.status;
  }

  if ("assignedToUid" in raw) {
    recognized = true;
    const value = raw.assignedToUid;
    if (value === null) {
      patch.assignedToUid = null;
    } else if (typeof value === "string" && value.trim()) {
      patch.assignedToUid = value.trim();
    } else {
      return {
        ok: false,
        error: "Owner must be an administrator id or null.",
      };
    }
  }

  if ("nextFollowUpAt" in raw) {
    recognized = true;
    const value = raw.nextFollowUpAt;
    if (value === null) {
      patch.nextFollowUpAt = null;
    } else if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        return { ok: false, error: "Follow-up must be a valid date." };
      }
      // Sanity bound: guards a typo'd year from hiding a lead forever.
      const max = new Date();
      max.setFullYear(max.getFullYear() + FOLLOW_UP_MAX_YEARS_AHEAD);
      if (parsed.getTime() > max.getTime()) {
        return {
          ok: false,
          error: `Follow-up cannot be more than ${FOLLOW_UP_MAX_YEARS_AHEAD} years out.`,
        };
      }
      patch.nextFollowUpAt = parsed;
    } else {
      return { ok: false, error: "Follow-up must be a date or null." };
    }
  }

  if ("outcome" in raw) {
    recognized = true;
    const value = raw.outcome;
    if (value === null || (typeof value === "string" && !value.trim())) {
      patch.outcome = null;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > TRADE_LEAD_OUTCOME_MAX_LENGTH) {
        return { ok: false, error: "Outcome is too long." };
      }
      patch.outcome = trimmed;
    } else {
      return { ok: false, error: "Outcome must be text or null." };
    }
  }

  if (!recognized) {
    return { ok: false, error: "No valid fields provided to update." };
  }
  return { ok: true, patch };
}

// Patch shape after the route has resolved `assignedToUid` to a verified
// admin identity.
export interface NormalizedLeadPatch {
  status?: TradeLeadStatus;
  assignee?: { uid: string; name: string } | null;
  nextFollowUpAt?: Date | null;
  outcome?: string | null;
}

export interface TradeLeadActivityDraft {
  type: TradeLeadActivityType;
  body?: string;
  details?: Record<string, string | null>;
}

export interface LeadUpdatePlan {
  changed: boolean;
  // Values may be a Date (→ Timestamp), DELETE_FIELD (→ FieldValue.delete()),
  // or a primitive. The server layer performs the translation.
  updates: Record<string, unknown>;
  activities: TradeLeadActivityDraft[];
}

function isoOf(millis: number | null): string | null {
  return millis === null ? null : new Date(millis).toISOString();
}

// Computes the field updates + activity entries for a lead mutation. Pure:
// the caller supplies the current record and `now`. Every produced change is
// a "meaningful" mutation, so a non-empty plan always advances `updatedAt`
// and `lastActivityAt` — the retention anchor (see TRADE_LEAD_RETENTION_*).
// Reads/views never produce a plan, so opening a lead cannot extend it.
export function buildLeadUpdate(
  current: Pick<
    TradeLeadRecord,
    "status" | "assignedToUid" | "assignedToName" | "nextFollowUpAt" | "outcome"
  >,
  patch: NormalizedLeadPatch,
  now: Date
): { ok: true; plan: LeadUpdatePlan } | { ok: false; error: string } {
  const updates: Record<string, unknown> = {};
  const activities: TradeLeadActivityDraft[] = [];

  const fromStatus = normalizeTradeLeadStatus(current.status);
  const toStatus = patch.status ?? fromStatus;
  const toTerminal = isTerminalLeadStatus(toStatus);
  const currentFollowUpMillis = timestampMillis(current.nextFollowUpAt);

  if (patch.status !== undefined && patch.status !== fromStatus) {
    const wasTerminal = isTerminalLeadStatus(fromStatus);
    updates.status = toStatus;
    activities.push({
      type: "status_changed",
      details: { from: fromStatus, to: toStatus },
    });
    if (toTerminal && !wasTerminal) {
      updates.closedAt = now;
      // A terminal lead leaves the follow-up queue; a scheduled follow-up on
      // it would only ever render as a misleading overdue state.
      if (currentFollowUpMillis !== null) {
        updates.nextFollowUpAt = DELETE_FIELD;
        activities.push({
          type: "follow_up_cleared",
          details: { at: isoOf(currentFollowUpMillis) },
        });
      }
    }
    if (!toTerminal && wasTerminal) {
      // Reopening a lead clears its terminal bookkeeping.
      updates.closedAt = DELETE_FIELD;
      updates.outcome = DELETE_FIELD;
    }
  }

  if (patch.outcome !== undefined) {
    if (!toTerminal) {
      return {
        ok: false,
        error: "Outcome only applies to customer or closed leads.",
      };
    }
    const trimmed = patch.outcome?.trim() || null;
    const currentOutcome =
      typeof current.outcome === "string" && current.outcome.trim()
        ? current.outcome.trim()
        : null;
    if (trimmed !== currentOutcome) {
      updates.outcome = trimmed ?? DELETE_FIELD;
      activities.push({
        type: "outcome_changed",
        details: { from: currentOutcome, to: trimmed },
      });
    }
  }

  if (patch.assignee !== undefined) {
    const toUid = patch.assignee?.uid ?? null;
    const fromUid = current.assignedToUid ?? null;
    if (toUid !== fromUid) {
      if (patch.assignee) {
        updates.assignedToUid = patch.assignee.uid;
        updates.assignedToName = patch.assignee.name;
      } else {
        updates.assignedToUid = DELETE_FIELD;
        updates.assignedToName = DELETE_FIELD;
      }
      activities.push({
        type: "owner_changed",
        details: {
          from: current.assignedToName ?? null,
          to: patch.assignee?.name ?? null,
        },
      });
    }
  }

  if (patch.nextFollowUpAt !== undefined && !toTerminal) {
    const toMillis = patch.nextFollowUpAt?.getTime() ?? null;
    if (toMillis !== currentFollowUpMillis) {
      if (toMillis === null) {
        updates.nextFollowUpAt = DELETE_FIELD;
        activities.push({
          type: "follow_up_cleared",
          details: { at: isoOf(currentFollowUpMillis) },
        });
      } else {
        updates.nextFollowUpAt = patch.nextFollowUpAt;
        activities.push({
          type:
            currentFollowUpMillis === null
              ? "follow_up_set"
              : "follow_up_changed",
          details: {
            at: patch.nextFollowUpAt!.toISOString(),
            from: isoOf(currentFollowUpMillis),
          },
        });
      }
    }
    // A follow-up PATCH that arrives with (or after) a terminal status is a
    // no-op by design: terminal leads cannot hold a follow-up.
  }

  if (Object.keys(updates).length === 0 && activities.length === 0) {
    return { ok: true, plan: { changed: false, updates: {}, activities: [] } };
  }

  updates.updatedAt = now;
  updates.lastActivityAt = now;
  return { ok: true, plan: { changed: true, updates, activities } };
}

// --- Manual lead creation ---

export interface ManualTradeLeadInput {
  businessName: string;
  contactName: string;
  email: string;
  phoneOrWhatsapp: string;
  venueType: string;
  message: string;
  source: Exclude<TradeLeadSource, typeof TRADE_LEAD_SOURCE>;
}

export function parseManualLeadBody(
  body: unknown
):
  | { ok: true; input: ManualTradeLeadInput }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body." };
  }
  const raw = body as Record<string, unknown>;
  const str = (key: string) =>
    typeof raw[key] === "string" ? (raw[key] as string).trim() : "";

  const businessName = str("businessName");
  const contactName = str("contactName");
  const email = str("email");
  const phoneOrWhatsapp = str("phoneOrWhatsapp");
  const venueTypeRaw = str("venueType");
  const message = str("message");
  const source = raw.source;

  if (!businessName) {
    return { ok: false, error: "Business name is required." };
  }
  if (businessName.length > TRADE_LEAD_FIELD_LIMITS.businessName) {
    return { ok: false, error: "Business name is too long." };
  }
  if (contactName.length > TRADE_LEAD_FIELD_LIMITS.contactName) {
    return { ok: false, error: "Contact name is too long." };
  }
  // Manual leads may arrive with only a phone number (a WhatsApp chat, a
  // business card) — require at least one usable contact channel.
  if (!email && !phoneOrWhatsapp) {
    return {
      ok: false,
      error: "Provide at least an email or a phone/WhatsApp number.",
    };
  }
  if (email && !isValidEmail(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (email.length > TRADE_LEAD_FIELD_LIMITS.email) {
    return { ok: false, error: "Email is too long." };
  }
  if (phoneOrWhatsapp.length > TRADE_LEAD_FIELD_LIMITS.phoneOrWhatsapp) {
    return { ok: false, error: "Phone/WhatsApp is too long." };
  }
  const venueType = venueTypeRaw || "other";
  if (!TRADE_VENUE_TYPES.some((t) => t.value === venueType)) {
    return { ok: false, error: "Choose a valid business type." };
  }
  if (message.length > TRADE_LEAD_FIELD_LIMITS.message) {
    return { ok: false, error: "Message is too long." };
  }
  if (!isManualLeadSource(source)) {
    return { ok: false, error: "Choose how this lead reached you." };
  }

  return {
    ok: true,
    input: {
      businessName,
      contactName,
      email,
      phoneOrWhatsapp,
      venueType,
      message,
      source,
    },
  };
}

export function validateNoteBody(
  body: unknown
): { ok: true; note: string } | { ok: false; error: string } {
  const note = typeof body === "string" ? body.trim() : "";
  if (!note) return { ok: false, error: "Write a note before saving." };
  if (note.length > TRADE_LEAD_NOTE_MAX_LENGTH) {
    return { ok: false, error: "Note is too long." };
  }
  return { ok: true, note };
}

// --- Timeline presentation ---

function formatDetailsDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

// One readable line per history entry — the "Oct 4, Malachy: Dropped off
// samples" shape from the issue. Note bodies render separately (verbatim,
// multi-line).
export function describeTradeLeadActivity(
  activity: Pick<TradeLeadActivityView, "type" | "details" | "communication">
): string {
  const details = activity.details ?? {};
  const detailStr = (key: string) =>
    typeof details[key] === "string" ? (details[key] as string) : null;
  switch (activity.type) {
    case "lead_created":
      return `Lead created — ${tradeLeadSourceLabel(detailStr("source"))}`;
    case "status_changed":
      return `Status changed from ${tradeLeadStatusLabel(detailStr("from"))} to ${tradeLeadStatusLabel(detailStr("to"))}`;
    case "owner_changed": {
      const to = detailStr("to");
      return to ? `Assigned to ${to}` : "Owner unassigned";
    }
    case "follow_up_set": {
      const at = formatDetailsDate(detailStr("at"));
      return at ? `Follow-up set for ${at}` : "Follow-up set";
    }
    case "follow_up_changed": {
      const at = formatDetailsDate(detailStr("at"));
      return at ? `Follow-up moved to ${at}` : "Follow-up changed";
    }
    case "follow_up_cleared":
      return "Follow-up cleared";
    case "outcome_changed": {
      const to = detailStr("to");
      return to ? `Outcome updated: ${to}` : "Outcome cleared";
    }
    case "communication": {
      const channel = activity.communication?.channel;
      const direction = activity.communication?.direction;
      const verb = direction === "inbound" ? "received" : "sent";
      return channel ? `Message ${verb} via ${channel}` : `Message ${verb}`;
    }
    case "note":
    default:
      return "Note";
  }
}
