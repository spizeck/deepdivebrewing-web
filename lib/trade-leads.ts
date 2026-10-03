import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { getResendClient } from "@/lib/resend";
import {
  getDefaultFromEmail,
  getTradeNotificationEmail,
} from "@/lib/resend-config";
import { logError, logInfo } from "@/lib/log";
import { normalizePhoneNumber } from "@/lib/phone";
import { siteUrl } from "@/lib/site";
import {
  escapeHtml,
  generateReplyToken,
} from "@/lib/trade-leads-email-common";
import {
  buildTradeLeadRecord,
  processTradeInquiry,
  tradeLeadIslandLabel,
  TRADE_LEADS_COLLECTION,
  TRADE_LEAD_SOURCE,
  type TradeInquiryOutcome,
  type TradeLeadInput,
} from "@/lib/trade-leads-common";
import { TRADE_LEAD_ACTIVITIES_SUBCOLLECTION } from "@/lib/trade-leads-admin-common";

export type { TradeLeadInput };

export async function persistTradeLead(input: TradeLeadInput): Promise<string> {
  const db = getFirebaseAdminDb();
  const leadRef = db.collection(TRADE_LEADS_COLLECTION).doc();
  const activityRef = leadRef
    .collection(TRADE_LEAD_ACTIVITIES_SUBCOLLECTION)
    .doc();

  // Lead document + its first history entry in one batch so every new lead
  // opens with a populated timeline (#150). The replyToken is the lead's
  // opaque inbound routing identity (#152); phoneNormalized stores the
  // canonical E.164 form when the submitted number parses cleanly.
  const phone = normalizePhoneNumber(input.phoneOrWhatsapp);
  const batch = db.batch();
  batch.set(leadRef, {
    ...buildTradeLeadRecord(input),
    replyToken: generateReplyToken(),
    ...(phone.e164 ? { phoneNormalized: phone.e164 } : {}),
    activityCount: 1,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastActivityAt: FieldValue.serverTimestamp(),
  });
  batch.set(activityRef, {
    type: "lead_created",
    seq: 0,
    details: { source: TRADE_LEAD_SOURCE },
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return leadRef.id;
}

async function sendTradeInquiryNotification(
  input: TradeLeadInput,
  leadId: string
): Promise<void> {
  // TRADE_NOTIFICATION_EMAIL is the canonical destination; the legacy
  // TRADE_INQUIRY_TO_EMAIL remains a fallback for un-migrated deployments.
  const toEmail = getTradeNotificationEmail();
  if (!toEmail) {
    throw new Error(
      "Destination email is not configured (TRADE_NOTIFICATION_EMAIL)."
    );
  }

  // Business name only — no contact details in the subject line. The body
  // carries the fields plus a deep link into the pipeline; the app is the
  // system of record, this email is a notification.
  const subject = `New Trade Inquiry: ${input.businessName}`;
  const leadUrl = `${siteUrl}/admin/trade?lead=${encodeURIComponent(leadId)}`;
  const html = `
      <h2>New Trade Inquiry</h2>
      <table style="border-collapse: collapse; width: 100%; max-width: 640px;">
        <tr><td style="padding: 8px; font-weight: 700;">Business Name</td><td style="padding: 8px;">${escapeHtml(input.businessName)}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Contact Name</td><td style="padding: 8px;">${escapeHtml(input.contactName)}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Email</td><td style="padding: 8px;"><a href="mailto:${escapeHtml(input.email)}">${escapeHtml(input.email)}</a></td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Phone / WhatsApp</td><td style="padding: 8px;">${escapeHtml(input.phoneOrWhatsapp) || "—"}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Business Type</td><td style="padding: 8px;">${escapeHtml(input.venueType)}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Island</td><td style="padding: 8px;">${escapeHtml(input.island ? tradeLeadIslandLabel(input.island) : "—")}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Message</td><td style="padding: 8px;">${escapeHtml(input.message) || "—"}</td></tr>
      </table>
      <p><a href="${leadUrl}">Open this lead in the trade pipeline</a></p>
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
