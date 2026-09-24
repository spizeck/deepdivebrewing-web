// Shared, dependency-free trade-inquiry logic. The request-validation and
// persistence/notification orchestration lives here (with injected
// collaborators) so it is unit-testable without Firebase Admin or Resend;
// `lib/trade-leads.ts` wires the real server-only dependencies.
import { isValidEmail } from "@/lib/email";
import type { LogContext } from "@/lib/log";

export const TRADE_LEADS_COLLECTION = "tradeLeads";
export const TRADE_LEAD_SOURCE = "trade_form";
export const TRADE_LEAD_INITIAL_STATUS = "new";

export interface TradeLeadInput {
  businessName: string;
  contactName: string;
  email: string;
  phoneOrWhatsapp: string;
  venueType: string;
  message: string;
}

// Upper bounds enforced before persistence so an oversized submission is a
// 400 validation error rather than a Firestore document-size failure.
export const TRADE_LEAD_FIELD_LIMITS = {
  businessName: 200,
  contactName: 200,
  email: 320,
  phoneOrWhatsapp: 64,
  venueType: 64,
  message: 4000,
} as const;

export function tradeLeadFieldTooLong(
  input: TradeLeadInput
): keyof TradeLeadInput | null {
  for (const [field, max] of Object.entries(TRADE_LEAD_FIELD_LIMITS)) {
    if (input[field as keyof TradeLeadInput].length > max)
      return field as keyof TradeLeadInput;
  }
  return null;
}

// Customer-facing names for validation messages — the raw API field keys
// (camelCase) must never reach the submitter.
const TRADE_LEAD_FIELD_LABELS: Record<keyof TradeLeadInput, string> = {
  businessName: "business name",
  contactName: "contact name",
  email: "email",
  phoneOrWhatsapp: "phone/WhatsApp",
  venueType: "business type",
  message: "message",
};

// --- Retention (owner policy, #59) ---
// Trade inquiries are retained for up to 24 months after the last meaningful
// activity, absent a legitimate business/legal/accounting/dispute/security
// reason to keep them longer. The retention anchor is `updatedAt` — today all
// records have updatedAt == createdAt (nothing modifies leads yet), so
// retention effectively runs from submission until lead-management tooling
// records later activity.
export const TRADE_LEAD_RETENTION_MONTHS = 24;

export function tradeLeadRetentionCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime());
  const month = cutoff.getUTCMonth();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - TRADE_LEAD_RETENTION_MONTHS / 12);
  // Leap-day edge: Feb 29 → clamp to Feb 28 rather than overflowing to Mar 1.
  if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
  return cutoff;
}

export type TradeLeadRetentionStatus = "expired" | "retained" | "unknown";

// A lead is expired when its retention anchor (updatedAt, falling back to
// createdAt) is at or before the cutoff. Records whose timestamp cannot be
// interpreted are "unknown" — never deleted automatically.
export function tradeLeadRetentionStatus(
  lead: { updatedAt?: unknown; createdAt?: unknown },
  cutoff: Date
): TradeLeadRetentionStatus {
  const millis = timestampMillis(lead.updatedAt ?? lead.createdAt);
  if (millis === null) return "unknown";
  return millis <= cutoff.getTime() ? "expired" : "retained";
}

// Accepts Date, firebase-admin Timestamp (toMillis), or a { seconds } shape.
function timestampMillis(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  const toMillis = (value as { toMillis?: unknown }).toMillis;
  if (typeof toMillis === "function") {
    try {
      const t = (toMillis as () => number).call(value);
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }
  const seconds = (value as { seconds?: unknown }).seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds)) {
    const millis = seconds * 1000;
    return Number.isFinite(millis) ? millis : null;
  }
  return null;
}

// Fields the API persists verbatim. Timestamps and lead id are added by the
// persistence layer; honeypot values, IPs, and request metadata are
// deliberately never part of the record.
export function buildTradeLeadRecord(input: TradeLeadInput) {
  return {
    businessName: input.businessName,
    contactName: input.contactName,
    email: input.email,
    phoneOrWhatsapp: input.phoneOrWhatsapp,
    venueType: input.venueType,
    message: input.message,
    status: TRADE_LEAD_INITIAL_STATUS,
    source: TRADE_LEAD_SOURCE,
  };
}

export interface TradeInquiryDeps {
  persist: (input: TradeLeadInput) => Promise<string>;
  notify: (input: TradeLeadInput, leadId: string) => Promise<void>;
  logInfo: (event: string, context?: LogContext) => void;
  logError: (event: string, error?: unknown, context?: LogContext) => void;
}

// `{ ok: false }` means persistence failed — the cause was already logged as
// `trade_inquiry.persistence_failed`, so callers must not log it again as an
// unclassified error.
export type TradeInquiryOutcome =
  | { ok: true; leadId: string }
  | { ok: false };

// --- POST /api/trade-inquiry request pipeline ---

// Untrusted JSON body shape; every field is optional at this boundary.
export interface TradeInquiryBody {
  businessName?: string;
  contactName?: string;
  email?: string;
  phoneOrWhatsapp?: string;
  venueType?: string;
  message?: string;
  website?: string;
}

export interface TradeInquiryRouteResult {
  status: number;
  body: { ok: boolean; error?: string };
}

export interface TradeInquiryRouteDeps {
  isRateLimited: (clientIp: string) => boolean;
  submit: (
    input: TradeLeadInput,
    requestId: string
  ) => Promise<TradeInquiryOutcome>;
}

// Everything between "JSON parsed" and "respond": trim → required fields →
// field-length bounds → email format → honeypot → rate limit → submit.
// All validation runs before the honeypot reply and before `submit`, so a
// malformed email can never reach Firestore or Resend.
export async function handleTradeInquiry(
  body: TradeInquiryBody,
  context: { clientIp: string; requestId: string },
  deps: TradeInquiryRouteDeps
): Promise<TradeInquiryRouteResult> {
  const businessName = body.businessName?.trim() ?? "";
  const contactName = body.contactName?.trim() ?? "";
  const email = body.email?.trim() ?? "";
  const phoneOrWhatsapp = body.phoneOrWhatsapp?.trim() ?? "";
  const venueType = body.venueType?.trim() ?? "";
  const message = body.message?.trim() ?? "";
  const website = body.website?.trim() ?? "";

  if (!businessName || !contactName || !email || !venueType) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "Please fill in all required fields.",
      },
    };
  }

  const oversized = tradeLeadFieldTooLong({
    businessName,
    contactName,
    email,
    phoneOrWhatsapp,
    venueType,
    message,
  });
  if (oversized) {
    return {
      status: 400,
      body: {
        ok: false,
        error: `Please shorten the ${TRADE_LEAD_FIELD_LABELS[oversized]} field.`,
      },
    };
  }

  if (!isValidEmail(email)) {
    return {
      status: 400,
      body: { ok: false, error: "Please enter a valid email address." },
    };
  }

  // Honeypot: pretend success for bots, but persist nothing and send no email.
  if (website) {
    return { status: 200, body: { ok: true } };
  }

  if (deps.isRateLimited(context.clientIp)) {
    return {
      status: 429,
      body: { ok: false, error: "Too many requests. Please try again later." },
    };
  }

  // Firestore is the system of record: the inquiry must be persisted before
  // we claim success. The Resend notification is best-effort inside submit —
  // its failure is logged, not surfaced to the customer.
  const outcome = await deps.submit(
    { businessName, contactName, email, phoneOrWhatsapp, venueType, message },
    context.requestId
  );
  if (!outcome.ok) {
    // Persistence failure was already logged as
    // trade_inquiry.persistence_failed — respond generically.
    return {
      status: 500,
      body: {
        ok: false,
        error: "Something went wrong on our end. Please try again.",
      },
    };
  }

  return { status: 200, body: { ok: true } };
}

// Persists the inquiry, then attempts the notification email. Persistence is
// the durability boundary: a notification failure is logged but does not fail
// the submission, while a persistence failure yields `{ ok: false }` so the
// route can return an error (there is no durable record).
export async function processTradeInquiry(
  input: TradeLeadInput,
  requestId: string,
  deps: TradeInquiryDeps
): Promise<TradeInquiryOutcome> {
  let leadId: string;
  try {
    leadId = await deps.persist(input);
  } catch (error) {
    deps.logError("trade_inquiry.persistence_failed", error, { requestId });
    return { ok: false };
  }

  deps.logInfo("trade_inquiry.persisted", {
    leadId,
    requestId,
    venueType: input.venueType,
  });

  try {
    await deps.notify(input, leadId);
    deps.logInfo("trade_inquiry.notification_sent", { leadId, requestId });
  } catch (error) {
    deps.logError("trade_inquiry.notification_failed", error, {
      leadId,
      requestId,
    });
  }

  return { ok: true, leadId };
}
