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

// Persists the inquiry, then attempts the notification email. Persistence is
// the durability boundary: a notification failure is logged but does not fail
// the submission, while a persistence failure propagates so the route can
// return an error (there is no durable record).
export async function processTradeInquiry(
  input: TradeLeadInput,
  requestId: string,
  deps: TradeInquiryDeps
): Promise<string> {
  let leadId: string;
  try {
    leadId = await deps.persist(input);
  } catch (error) {
    deps.logError("trade_inquiry.persistence_failed", error, { requestId });
    throw error;
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

  return leadId;
}
