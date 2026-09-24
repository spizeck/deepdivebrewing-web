import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin";
import { getResendClient } from "@/lib/resend";
import { getDefaultFromEmail } from "@/lib/resend-config";
import { logError, logInfo } from "@/lib/log";
import {
  buildTradeLeadRecord,
  processTradeInquiry,
  TRADE_LEADS_COLLECTION,
  type TradeInquiryOutcome,
  type TradeLeadInput,
} from "@/lib/trade-leads-common";

export type { TradeLeadInput };

export async function persistTradeLead(input: TradeLeadInput): Promise<string> {
  const ref = await getFirebaseAdminDb()
    .collection(TRADE_LEADS_COLLECTION)
    .add({
      ...buildTradeLeadRecord(input),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  return ref.id;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function sendTradeInquiryNotification(
  input: TradeLeadInput,
  leadId: string
): Promise<void> {
  const toEmail = process.env.TRADE_INQUIRY_TO_EMAIL;
  if (!toEmail) {
    throw new Error(
      "Destination email is not configured (TRADE_INQUIRY_TO_EMAIL)."
    );
  }

  const subject = `Trade Inquiry — ${input.businessName} (${input.contactName})`;
  const html = `
      <h2>New Trade Inquiry</h2>
      <table style="border-collapse: collapse; width: 100%; max-width: 640px;">
        <tr><td style="padding: 8px; font-weight: 700;">Reference</td><td style="padding: 8px;">${escapeHtml(leadId)}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Business Name</td><td style="padding: 8px;">${escapeHtml(input.businessName)}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Contact Name</td><td style="padding: 8px;">${escapeHtml(input.contactName)}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Email</td><td style="padding: 8px;"><a href="mailto:${escapeHtml(input.email)}">${escapeHtml(input.email)}</a></td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Phone / WhatsApp</td><td style="padding: 8px;">${escapeHtml(input.phoneOrWhatsapp) || "—"}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Business Type</td><td style="padding: 8px;">${escapeHtml(input.venueType)}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Message</td><td style="padding: 8px;">${escapeHtml(input.message) || "—"}</td></tr>
      </table>
    `;

  const { error } = await getResendClient().emails.send({
    from: getDefaultFromEmail(),
    to: toEmail,
    replyTo: input.email,
    subject,
    html,
  });

  if (error) {
    throw new Error(error.message);
  }
}

// Server-side entry point for POST /api/trade-inquiry: persists the inquiry to
// Firestore (the durable record), then sends the Resend notification as a
// best-effort side effect. `{ ok: false }` means persistence failed (already
// logged); notification failures never fail the outcome.
export async function submitTradeInquiry(
  input: TradeLeadInput,
  requestId: string
): Promise<TradeInquiryOutcome> {
  return processTradeInquiry(input, requestId, {
    persist: persistTradeLead,
    notify: sendTradeInquiryNotification,
    logInfo,
    logError,
  });
}
