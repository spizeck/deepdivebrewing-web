// Shared, dependency-free trade-inquiry logic. The persistence/notification
// orchestration lives here (with injected collaborators) so it is unit-testable
// without Firebase Admin or Resend; `lib/trade-leads.ts` wires the real
// server-only dependencies.
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

export function tradeLeadFieldTooLong(input: TradeLeadInput): string | null {
  for (const [field, max] of Object.entries(TRADE_LEAD_FIELD_LIMITS)) {
    if (input[field as keyof TradeLeadInput].length > max) return field;
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
