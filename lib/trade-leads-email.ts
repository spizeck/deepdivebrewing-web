import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { getResendClient } from "@/lib/resend";
import {
  getInboundReplyDomain,
  getResendWebhookSecret,
  getTradeFromEmail,
  getTradeNotificationEmail,
} from "@/lib/resend-config";
import { getAdminUser } from "@/lib/admin-users";
import { logInfo, logWarn } from "@/lib/log";
import { siteUrl } from "@/lib/site";
import { TRADE_LEADS_COLLECTION } from "@/lib/trade-leads-common";
import { type TradeLeadActor } from "@/lib/trade-leads-admin";
import {
  TRADE_LEAD_ACTIVITIES_SUBCOLLECTION,
  TradeLeadError,
  TradeLeadNotFoundError,
} from "@/lib/trade-leads-admin-common";
import {
  deliveryStateForEvent,
  emailPreview,
  escapeHtml,
  extractReplyToken,
  generateReplyToken,
  htmlToPlainText,
  isReplyToken,
  outboundMessageId,
  parseOutboundMessageBody,
  plainTextToHtml,
  replyAddressForToken,
  replyNotificationRecipient,
  resolveInboundThreadId,
  senderDomain,
  shouldAdvanceDeliveryState,
  TRADE_EMAIL_MAX_ATTACHMENTS,
  TRADE_LEAD_COMMUNICATIONS_SUBCOLLECTION,
  truncateEmailBody,
  type ParsedOutboundMessage,
  type ThreadCandidate,
  type TradeLeadCommunicationRecord,
} from "@/lib/trade-leads-email-common";

// Server-side trade-lead email pipeline (Issue #152). The app is the system
// of record: outbound sends and inbound replies are communication documents
// under tradeLeads/{id}/communications plus a `communication` entry in the
// activities timeline. Staff notifications are a separate channel — they
// are never recorded as lead communications.

// Fields pulled into operational logs. Bodies, recipients, subjects, and
// customer addresses are PII-adjacent and never logged — ids only.

export class TradeLeadEmailSendError extends TradeLeadError {
  constructor() {
    super("The email could not be sent.", 502);
  }
}

// --- Outbound ---

export interface SendLeadEmailResult {
  communicationId: string;
  threadId: string;
}

interface PreparedSend {
  to: string;
  replyTo: string;
  headers: Record<string, string>;
  communicationId: string;
  threadId: string;
  messageId: string;
}

// Stage 1: validate + persist the outbound communication and its timeline
// entry in one transaction (the history record must exist before the send
// is attempted so a provider failure is still recorded honestly).
async function prepareOutboundEmail(
  leadId: string,
  message: ParsedOutboundMessage,
  actor: TradeLeadActor,
  from: string,
  replyDomain: string
): Promise<PreparedSend> {
  const db = getFirebaseAdminDb();
  const leadRef = db.collection(TRADE_LEADS_COLLECTION).doc(leadId);
  const commRef = leadRef
    .collection(TRADE_LEAD_COMMUNICATIONS_SUBCOLLECTION)
    .doc();
  const activityRef = leadRef
    .collection(TRADE_LEAD_ACTIVITIES_SUBCOLLECTION)
    .doc();
  const now = new Date();
  const messageId = outboundMessageId(commRef.id, senderDomain(from));

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(leadRef);
    if (!snap.exists) throw new TradeLeadNotFoundError();
    const lead = snap.data() ?? {};

    // Mail-relay containment: the only permitted recipient is the lead's own
    // contact address — no caller-supplied `to` is ever accepted.
    const to = typeof lead.email === "string" ? lead.email.trim() : "";
    if (!to) {
      throw new TradeLeadError(
        "This lead has no email address on file.",
        400
      );
    }

    // Backfill the routing token on pre-#152 leads inside the same write so
    // the outbound Reply-To and the displayed attach address agree.
    let token = lead.replyToken;
    const leadUpdates: Record<string, unknown> = {};
    if (!isReplyToken(token)) {
      token = generateReplyToken();
      leadUpdates.replyToken = token;
    }

    // Reply threading: resolve the referenced communication and seed
    // In-Reply-To/References + threadId from it. Any other message starts a
    // new thread rooted at itself.
    let inReplyTo: string | undefined;
    let references: string[] | undefined;
    let threadId = commRef.id;
    if (message.replyToCommunicationId) {
      const targetSnap = await tx.get(
        leadRef
          .collection(TRADE_LEAD_COMMUNICATIONS_SUBCOLLECTION)
          .doc(message.replyToCommunicationId)
      );
      if (!targetSnap.exists) {
        throw new TradeLeadError("The message being replied to no longer exists.", 404);
      }
      const target = targetSnap.data() ?? {};
      threadId =
        typeof target.threadId === "string" && target.threadId
          ? target.threadId
          : targetSnap.id;
      const targetMessageId =
        typeof target.messageId === "string" ? target.messageId : "";
      if (targetMessageId) {
        inReplyTo = targetMessageId;
        const priorRefs = Array.isArray(target.references)
          ? target.references.filter(
              (r): r is string => typeof r === "string" && !!r
            )
          : [];
        references = [...priorRefs, targetMessageId];
      }
    }

    const record: Omit<TradeLeadCommunicationRecord, "createdAt"> & {
      createdAt: FieldValue;
    } = {
      channel: "email",
      direction: "outbound",
      from,
      to: [to],
      subject: message.subject,
      textBody: message.body,
      provider: "resend",
      messageId,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references ? { references } : {}),
      threadId,
      sentAt: Timestamp.fromDate(now),
      sentByUid: actor.uid,
      sentByName: actor.name,
      deliveryState: "queued",
      createdAt: FieldValue.serverTimestamp(),
    };
    tx.set(commRef, record);

    const base =
      typeof lead.activityCount === "number" ? lead.activityCount : 0;
    tx.set(activityRef, {
      type: "communication",
      seq: base,
      authorUid: actor.uid,
      authorName: actor.name,
      communication: {
        channel: "email",
        direction: "outbound",
        communicationId: commRef.id,
        recipient: to,
        subject: message.subject,
        preview: emailPreview(message.body),
        sentByUid: actor.uid,
        sentByName: actor.name,
        provider: "resend",
        deliveryState: "queued",
        threadId,
      },
      createdAt: FieldValue.serverTimestamp(),
    });

    // Sending email is meaningful activity — advances the retention anchor.
    tx.update(leadRef, {
      ...leadUpdates,
      activityCount: base + 1,
      updatedAt: FieldValue.serverTimestamp(),
      lastActivityAt: FieldValue.serverTimestamp(),
    });

    const headers: Record<string, string> = { "Message-ID": messageId };
    if (inReplyTo) headers["In-Reply-To"] = inReplyTo;
    if (references?.length) headers["References"] = references.join(" ");

    return {
      to,
      replyTo: replyAddressForToken(token as string, replyDomain),
      headers,
      communicationId: commRef.id,
      threadId,
      messageId,
    };
  });
}

// Sends an admin-composed email to the lead's contact address via Resend and
// records it in the pipeline. Failures mark the communication "failed" — the
// timeline shows the real outcome rather than a false success.
export async function sendLeadEmail(
  leadId: string,
  message: ParsedOutboundMessage,
  actor: TradeLeadActor
): Promise<SendLeadEmailResult> {
  const from = getTradeFromEmail();
  const replyDomain = getInboundReplyDomain();
  const prepared = await prepareOutboundEmail(
    leadId,
    message,
    actor,
    from,
    replyDomain
  );

  const commRef = getFirebaseAdminDb()
    .collection(TRADE_LEADS_COLLECTION)
    .doc(leadId)
    .collection(TRADE_LEAD_COMMUNICATIONS_SUBCOLLECTION)
    .doc(prepared.communicationId);

  const { data, error } = await getResendClient().emails.send({
    from,
    to: prepared.to,
    replyTo: prepared.replyTo,
    subject: message.subject,
    text: message.body,
    html: plainTextToHtml(message.body),
    headers: prepared.headers,
  });

  if (error || !data?.id) {
    await commRef
      .update({
        deliveryState: "failed",
        deliveryStateAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});
    throw new TradeLeadEmailSendError();
  }

  await commRef.update({
    providerEmailId: data.id,
    deliveryState: "sent",
    deliveryStateAt: FieldValue.serverTimestamp(),
  });

  return {
    communicationId: prepared.communicationId,
    threadId: prepared.threadId,
  };
}

export { parseOutboundMessageBody };

// --- Webhook verification ---

export interface VerifiedWebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

// Verifies the svix signature on the raw request body. Throws on an
// unconfigured secret or an invalid/missing signature — the route maps both
// to refusals.
export function verifyResendWebhook(
  rawPayload: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null }
): VerifiedWebhookEvent {
  const secret = getResendWebhookSecret();
  if (!secret) {
    throw new Error("Resend webhook secret is not configured (RESEND_WEBHOOK_SECRET).");
  }
  const event = getResendClient().webhooks.verify({
    payload: rawPayload,
    headers: {
      id: headers.id ?? "",
      timestamp: headers.timestamp ?? "",
      signature: headers.signature ?? "",
    },
    webhookSecret: secret,
  });
  return {
    type: event.type,
    data: (event.data ?? {}) as unknown as Record<string, unknown>,
  };
}

// --- Inbound ---

export type InboundOutcome = "recorded" | "duplicate" | "ignored";

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && !!v);
}

function parseIsoDate(value: unknown): Timestamp | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

interface InboundMessageContent {
  text: string;
  html: string | null;
  headers: Record<string, string>;
  messageId?: string;
  attachments: {
    providerAttachmentId?: string;
    filename?: string;
    contentType?: string;
    size?: number;
  }[];
}

// Fetches the full inbound message from Resend — the webhook payload carries
// metadata only; bodies are retrieved server-side at processing time.
async function fetchInboundMessage(emailId: string): Promise<InboundMessageContent> {
  const { data, error } = await getResendClient().emails.receiving.get(
    emailId,
    { html_format: "cid" }
  );
  if (error || !data) {
    throw new Error(
      `Failed to retrieve inbound email content (${error?.message ?? "no data"}).`
    );
  }
  const headers: Record<string, string> = {};
  if (data.headers && typeof data.headers === "object") {
    for (const [key, value] of Object.entries(data.headers)) {
      if (typeof value === "string") headers[key.toLowerCase()] = value;
    }
  }
  const attachments = (data.attachments ?? [])
    .slice(0, TRADE_EMAIL_MAX_ATTACHMENTS)
    .map((a) => ({
      providerAttachmentId: a.id || undefined,
      filename: a.filename || undefined,
      contentType: a.content_type || undefined,
      size: typeof a.size === "number" ? a.size : undefined,
    }));
  return {
    text: data.text ?? "",
    html: data.html ?? null,
    headers,
    messageId: data.message_id || headers["message-id"],
    attachments,
  };
}

// Records an inbound customer email on the matching lead. Routing order:
// the opaque token in the recipient address is the primary correlation;
// In-Reply-To/References then pick the thread within the lead.
export async function handleInboundEmail(
  data: Record<string, unknown>
): Promise<InboundOutcome> {
  const db = getFirebaseAdminDb();
  const replyDomain = getInboundReplyDomain();

  const emailId = typeof data.email_id === "string" ? data.email_id : "";
  if (!emailId) return "ignored";

  const recipients = [
    ...asStringArray(data.received_for),
    ...asStringArray(data.to),
    ...asStringArray(data.cc),
    ...asStringArray(data.bcc),
  ];
  const token = extractReplyToken(recipients, replyDomain);
  if (!token) {
    // Not addressed to a lead routing address — a stray event for this
    // webhook (e.g. mail to another inbound address on the domain).
    logInfo("trade_email.inbound_unmatched", { emailId });
    return "ignored";
  }

  const leadQuery = await db
    .collection(TRADE_LEADS_COLLECTION)
    .where("replyToken", "==", token)
    .limit(1)
    .get();
  if (leadQuery.empty) {
    // Unknown tokens fail safe — nothing is created from inbound mail.
    // (Key name avoids "token" — the log sanitizer drops such keys.)
    logWarn("trade_email.inbound_unknown_token", {
      emailId,
      routingLocal: token,
    });
    return "ignored";
  }
  const leadRef = leadQuery.docs[0]!.ref;
  const leadId = leadRef.id;

  const commId = `inb_${emailId}`;
  const commRef = leadRef
    .collection(TRADE_LEAD_COMMUNICATIONS_SUBCOLLECTION)
    .doc(commId);

  // Cheap pre-dedupe before fetching content — a provider retry of a
  // recorded message exits without the extra API call. The transaction
  // below re-checks authoritatively.
  const existing = await commRef.get();
  if (existing.exists) return "duplicate";

  const content = await fetchInboundMessage(emailId);
  const rawText = content.text || htmlToPlainText(content.html ?? "");
  const { text: textBody, truncated } = truncateEmailBody(rawText);

  const headers = content.headers;
  const inReplyTo = headers["in-reply-to"];
  const references = (headers["references"] ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 30);
  const messageId = content.messageId ?? headers["message-id"];
  const subject =
    (typeof data.subject === "string" && data.subject) ||
    (typeof headers["subject"] === "string" ? headers["subject"] : "") ||
    "(no subject)";
  const from =
    (typeof data.from === "string" && data.from) ||
    headers["from"] ||
    "(unknown sender)";
  const receivedAt = parseIsoDate(data.created_at);

  const result = await db.runTransaction(
    async (tx): Promise<{ outcome: InboundOutcome; lead?: Record<string, unknown> }> => {
      const leadSnap = await tx.get(leadRef);
      if (!leadSnap.exists) return { outcome: "ignored" };
      const lead = leadSnap.data() ?? {};

      const commSnap = await tx.get(commRef);
      if (commSnap.exists) return { outcome: "duplicate" };

      // Thread correlation: match threading headers against stored
      // Message-IDs on this lead's communications.
      const priorComms = await tx.get(
        leadRef
          .collection(TRADE_LEAD_COMMUNICATIONS_SUBCOLLECTION)
          .select("messageId", "threadId", "direction")
      );
      const candidates: ThreadCandidate[] = priorComms.docs.map((doc) => {
        const d = doc.data();
        return {
          id: doc.id,
          messageId: typeof d.messageId === "string" ? d.messageId : undefined,
          threadId: typeof d.threadId === "string" ? d.threadId : undefined,
          direction: typeof d.direction === "string" ? d.direction : undefined,
        };
      });
      const threadId = resolveInboundThreadId(
        candidates,
        { inReplyTo, references },
        commId
      );

      const record: Omit<TradeLeadCommunicationRecord, "createdAt"> & {
        createdAt: FieldValue;
      } = {
        channel: "email",
        direction: "inbound",
        from,
        to: asStringArray(data.to),
        ...(asStringArray(data.cc).length
          ? { cc: asStringArray(data.cc) }
          : {}),
        subject,
        textBody,
        ...(truncated ? { truncated: true } : {}),
        ...(content.attachments.length
          ? { attachments: content.attachments }
          : {}),
        provider: "resend",
        providerEmailId: emailId,
        ...(messageId ? { messageId } : {}),
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references.length ? { references } : {}),
        threadId,
        ...(receivedAt ? { receivedAt } : {}),
        deliveryState: "received",
        createdAt: FieldValue.serverTimestamp(),
      };
      tx.set(commRef, record);

      const base =
        typeof lead.activityCount === "number" ? lead.activityCount : 0;
      tx.set(
        leadRef.collection(TRADE_LEAD_ACTIVITIES_SUBCOLLECTION).doc(),
        {
          type: "communication",
          seq: base,
          communication: {
            channel: "email",
            direction: "inbound",
            communicationId: commId,
            sender: from,
            subject,
            preview: emailPreview(textBody),
            provider: "resend",
            providerMessageId: emailId,
            deliveryState: "received",
            threadId,
          },
          createdAt: FieldValue.serverTimestamp(),
        }
      );

      // An inbound reply is meaningful activity — it advances the retention
      // anchor. (Reads/views never do.)
      tx.update(leadRef, {
        activityCount: base + 1,
        updatedAt: FieldValue.serverTimestamp(),
        lastActivityAt: FieldValue.serverTimestamp(),
      });

      return { outcome: "recorded", lead };
    }
  );

  if (result.outcome === "recorded" && result.lead) {
    // Best-effort staff notification — never blocks or retries the inbound
    // record. Notification failures are logged, not fatal.
    try {
      await notifyCustomerReply(leadId, result.lead, subject, from);
    } catch (error) {
      logWarn("trade_email.reply_notification_failed", {
        leadId,
        emailId,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return result.outcome;
}

// --- Staff notifications (system channel — never recorded on the lead) ---

// A customer replied: notify the assigned owner's admin email when there is
// one, else the shared trade notification mailbox. The notification links to
// the lead; it is deliberately not CC'd into the customer-facing thread.
export async function notifyCustomerReply(
  leadId: string,
  lead: Record<string, unknown>,
  inboundSubject: string,
  inboundFrom: string
): Promise<void> {
  const ownerUid =
    typeof lead.assignedToUid === "string" && lead.assignedToUid
      ? lead.assignedToUid
      : null;
  let ownerEmail: string | undefined;
  if (ownerUid) {
    const owner = await getAdminUser(ownerUid);
    if (owner?.status === "active") ownerEmail = owner.email;
  }
  const to = replyNotificationRecipient(
    ownerEmail,
    getTradeNotificationEmail()
  );
  if (!to) {
    logWarn("trade_email.reply_notification_skipped", { leadId });
    return;
  }

  const businessName =
    typeof lead.businessName === "string" && lead.businessName
      ? lead.businessName
      : "Trade lead";
  const leadUrl = `${siteUrl}/admin/trade?lead=${encodeURIComponent(leadId)}`;
  const subject = `Trade Reply: ${businessName}`;
  const html = `
      <h2>Customer reply</h2>
      <table style="border-collapse: collapse; width: 100%; max-width: 640px;">
        <tr><td style="padding: 8px; font-weight: 700;">Lead</td><td style="padding: 8px;">${escapeHtml(businessName)}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">From</td><td style="padding: 8px;">${escapeHtml(inboundFrom)}</td></tr>
        <tr><td style="padding: 8px; font-weight: 700;">Subject</td><td style="padding: 8px;">${escapeHtml(inboundSubject)}</td></tr>
      </table>
      <p><a href="${leadUrl}">Open this lead in the trade pipeline</a></p>
    `;

  const { error } = await getResendClient().emails.send({
    from: getTradeFromEmail(),
    to,
    subject,
    html,
  });
  if (error) throw new Error(error.message);
  logInfo("trade_email.reply_notification_sent", { leadId });
}

// --- Delivery-status callbacks ---

export type DeliveryOutcome = "updated" | "ignored" | "unknown_message";

// Applies an email.* delivery event to the matching outbound communication.
// Idempotent by state ranking: replayed or out-of-order events never regress
// the stored state, and events for messages we did not send from a lead
// (staff notifications, invitations, …) resolve to nothing.
export async function applyDeliveryEvent(
  type: string,
  data: Record<string, unknown>
): Promise<DeliveryOutcome> {
  const state = deliveryStateForEvent(type);
  if (!state) return "ignored";

  const emailId = typeof data.email_id === "string" ? data.email_id : "";
  if (!emailId) return "ignored";

  const db = getFirebaseAdminDb();
  const snap = await db
    .collectionGroup(TRADE_LEAD_COMMUNICATIONS_SUBCOLLECTION)
    .where("providerEmailId", "==", emailId)
    .limit(2)
    .get();
  if (snap.empty) return "unknown_message";

  const doc = snap.docs[0]!;
  const current = doc.data().deliveryState;
  if (!shouldAdvanceDeliveryState(current, state)) return "ignored";

  const updates: Record<string, unknown> = {
    deliveryState: state,
    deliveryStateAt: FieldValue.serverTimestamp(),
  };
  // Provider diagnostics for failures — a short machine detail, never the
  // raw event.
  const bounce = data.bounce as { message?: unknown; type?: unknown } | undefined;
  const failed = data.failed as { reason?: unknown } | undefined;
  const detail =
    (typeof bounce?.type === "string" && bounce.type) ||
    (typeof failed?.reason === "string" && failed.reason) ||
    undefined;
  if (detail) updates.deliveryDetails = detail.slice(0, 300);
  await doc.ref.update(updates);
  return "updated";
}
