// Shared, dependency-free domain logic for trade-lead email (Issue #152):
// inbound routing tokens, delivery states, threading/correlation helpers,
// body normalization, and serialization. Same split as the other trade
// modules — this file is safe for client components (no firebase/resend
// imports); lib/trade-leads-email.ts wires the server-only dependencies.
import { toIsoString } from "@/lib/admin-serializers";

export const TRADE_LEAD_COMMUNICATIONS_SUBCOLLECTION = "communications";

// --- Inbound routing tokens ---
//
// Every lead carries an opaque `replyToken` that forms its inbound email
// address: <token>@<reply domain> (e.g. 7K4M2QX9@reply.deepdivebrewing.com).
// The token — never the Firestore document id — is the public routing
// identity: it is random, non-sequential, and non-guessable, so knowing an
// address reveals nothing about the underlying record. Replies to app-sent
// email (Reply-To) and manually forwarded mail ("attach email to this
// lead") both land on this address.

// Crockford-style alphabet: uppercase letters + digits minus the ambiguous
// 0, 1, I, L, O (staff copy these addresses into mail clients by hand).
const REPLY_TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const REPLY_TOKEN_LENGTH = 8;
const REPLY_TOKEN_REGEX = /^[A-HJ-NP-Z2-9]{8}$/;

export function isReplyToken(value: unknown): value is string {
  return typeof value === "string" && REPLY_TOKEN_REGEX.test(value);
}

// Random token from the unambiguous alphabet. Uses the Web Crypto API —
// available in both the browser and Node 24 without an import.
export function generateReplyToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(REPLY_TOKEN_LENGTH));
  let token = "";
  for (const byte of bytes) {
    token += REPLY_TOKEN_ALPHABET[byte % REPLY_TOKEN_ALPHABET.length];
  }
  return token;
}

export function replyAddressForToken(token: string, domain: string): string {
  return `${token}@${domain}`;
}

// Extracts a routing token from a list of recipient addresses
// (received_for/to/cc) — the local part of any address on our configured
// inbound domain that matches the token shape. Header values may carry
// display names ("Name <addr@dom>") so the address part is pulled out
// first. Returns null when no address matches: inbound mail to unknown
// tokens never resolves to a lead.
export function extractReplyToken(
  recipients: readonly string[],
  domain: string
): string | null {
  const suffix = `@${domain.toLowerCase()}`;
  for (const recipient of recipients) {
    if (typeof recipient !== "string") continue;
    const angle = recipient.lastIndexOf("<");
    const address = (
      angle >= 0 ? recipient.slice(angle + 1, recipient.indexOf(">", angle)) : recipient
    ).trim();
    const lower = address.toLowerCase();
    if (!lower.endsWith(suffix)) continue;
    // Local parts are uppercase-only tokens; a client that lowercased the
    // address still resolves.
    const local = address
      .slice(0, address.length - suffix.length)
      .toUpperCase();
    if (isReplyToken(local)) return local;
  }
  return null;
}

// --- Delivery states ---
//
// Outbound lifecycle driven by Resend webhook events: an accepted send is
// "sent"; subsequent email.* events advance the state. Ranked so a stale
// "sent" can never overwrite "delivered", while terminal failure states
// (bounced/failed/complained — a delayed bounce arrives after delivery)
// always win. Inbound messages sit at "received".
export const TRADE_EMAIL_DELIVERY_STATES = [
  "queued",
  "sent",
  "delivery_delayed",
  "delivered",
  "bounced",
  "complained",
  "failed",
  "received",
] as const;

export type TradeEmailDeliveryState =
  (typeof TRADE_EMAIL_DELIVERY_STATES)[number];

const DELIVERY_STATE_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  bounced: 4,
  complained: 4,
  failed: 4,
  received: 3,
};

export function deliveryStateRank(state: unknown): number {
  return typeof state === "string" ? (DELIVERY_STATE_RANK[state] ?? -1) : -1;
}

// A provider event should only move a communication forward — replays and
// out-of-order delivery are ignored by rank.
export function shouldAdvanceDeliveryState(
  current: unknown,
  next: string
): boolean {
  const nextRank = deliveryStateRank(next);
  if (nextRank < 0) return false;
  return nextRank > deliveryStateRank(current);
}

// Maps a Resend email.* webhook type to the stored delivery state.
// Returns null for events we don't track (email.received, opens, contacts…).
export function deliveryStateForEvent(type: string): TradeEmailDeliveryState | null {
  switch (type) {
    case "email.sent":
      return "sent";
    case "email.delivered":
      return "delivered";
    case "email.delivery_delayed":
      return "delivery_delayed";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "complained";
    case "email.failed":
      return "failed";
    default:
      return null;
  }
}

// --- Outbound composer validation ---

export const TRADE_EMAIL_SUBJECT_MAX = 200;
export const TRADE_EMAIL_BODY_MAX = 20_000;

export interface ParsedOutboundMessage {
  subject: string;
  body: string;
  // Optional: the communications doc id this message replies to — drives
  // In-Reply-To/References headers and thread grouping.
  replyToCommunicationId?: string;
}

// Header-injection guard: CR/LF must never survive into a value that lands
// in an email header.
function stripHeaderBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

export function parseOutboundMessageBody(
  body: unknown
):
  | { ok: true; message: ParsedOutboundMessage }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body." };
  }
  const raw = body as Record<string, unknown>;

  const subject =
    typeof raw.subject === "string" ? stripHeaderBreaks(raw.subject) : "";
  if (!subject) return { ok: false, error: "Write a subject before sending." };
  if (subject.length > TRADE_EMAIL_SUBJECT_MAX) {
    return { ok: false, error: "Subject is too long." };
  }

  const text = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!text) return { ok: false, error: "Write a message before sending." };
  if (text.length > TRADE_EMAIL_BODY_MAX) {
    return { ok: false, error: "Message is too long." };
  }

  const replyToCommunicationId =
    typeof raw.replyToCommunicationId === "string" &&
    raw.replyToCommunicationId.trim()
      ? raw.replyToCommunicationId.trim()
      : undefined;

  return {
    ok: true,
    message: { subject, body: text, replyToCommunicationId },
  };
}

// --- Inbound body normalization ---

// Stored-text cap: comfortably under Firestore's 1 MiB document limit while
// keeping oversized mail from bloating the record. Truncated bodies are
// marked in the preview.
export const TRADE_EMAIL_STORED_BODY_MAX = 60_000;
export const TRADE_EMAIL_PREVIEW_LENGTH = 240;
export const TRADE_EMAIL_MAX_ATTACHMENTS = 20;

export function truncateEmailBody(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= TRADE_EMAIL_STORED_BODY_MAX) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, TRADE_EMAIL_STORED_BODY_MAX), truncated: true };
}

// Minimal HTML → text for inbound mail that arrives without a plain-text
// part. The result is stored/displayed as *text* — the app never renders
// raw inbound HTML, which is the XSS boundary. This is a display
// convenience, not a sanitizer for re-injection as markup.
export function htmlToPlainText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  text = decodeBasicEntities(text);
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    });
}

// Plain-text → minimal HTML for app-sent mail: escape, then paragraphs on
// blank lines and <br> on single newlines.
export function plainTextToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function emailPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TRADE_EMAIL_PREVIEW_LENGTH) return flat;
  return `${flat.slice(0, TRADE_EMAIL_PREVIEW_LENGTH)}…`;
}

// --- Communication records ---

// Metadata-only attachment shape — actual content ingestion/storage is
// deliberately not implemented (see docs). Enough to show "attachment:
// price-list.pdf (240 KB)" in the timeline and to fetch content later via
// the provider if attachment support is built out.
export interface TradeLeadAttachmentMeta {
  providerAttachmentId?: string;
  filename?: string;
  contentType?: string;
  size?: number;
}

// Document shape in tradeLeads/{leadId}/communications/{communicationId}.
export interface TradeLeadCommunicationRecord {
  channel: "email";
  direction: "outbound" | "inbound";
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  textBody: string;
  truncated?: boolean;
  attachments?: TradeLeadAttachmentMeta[];
  provider: "resend";
  providerEmailId?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  threadId: string;
  sentAt?: unknown;
  receivedAt?: unknown;
  sentByUid?: string;
  sentByName?: string;
  deliveryState: TradeEmailDeliveryState;
  deliveryDetails?: string;
  deliveryStateAt?: unknown;
  createdAt: unknown;
}

// Serialized view for the admin client — ISO timestamps, primitives only.
export interface TradeLeadCommunicationView {
  id: string;
  channel: string;
  direction: "outbound" | "inbound";
  from?: string;
  to: string[];
  cc: string[];
  subject?: string;
  textBody?: string;
  truncated?: boolean;
  attachments?: TradeLeadAttachmentMeta[];
  providerEmailId?: string;
  messageId?: string;
  threadId?: string;
  sentAt?: string;
  receivedAt?: string;
  sentByName?: string;
  deliveryState?: string;
  deliveryDetails?: string;
  createdAt?: string;
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && !!v);
}

// --- Threading ---
//
// A lead may hold several email threads over time. `threadId` is the id of
// the communication document at the root of the thread. Correlation order:
// explicit In-Reply-To/References match against stored RFC Message-IDs
// first (normal reply semantics), then the routing token's lead-level
// thread — the token is the reliable fallback because forwarded mail
// frequently arrives with no usable threading headers.

// Minimal view used for correlation: what the server already fetched.
export interface ThreadCandidate {
  id: string;
  messageId?: string;
  threadId?: string;
  direction?: string;
}

// Given the lead's existing communications and an inbound message's
// threading headers, returns the thread this message continues — or the
// new-thread id (the inbound doc's own id) when nothing matches.
export function resolveInboundThreadId(
  existing: ThreadCandidate[],
  headers: { inReplyTo?: string; references?: string[] },
  selfId: string
): string {
  const wanted = new Set<string>();
  if (headers.inReplyTo) wanted.add(headers.inReplyTo);
  for (const ref of headers.references ?? []) {
    if (ref) wanted.add(ref);
  }
  if (wanted.size > 0) {
    // Prefer the most recently created match — later messages in the same
    // thread carry the same root anyway, so any match is correct; the
    // order just makes multi-thread leads behave intuitively.
    for (let i = existing.length - 1; i >= 0; i--) {
      const comm = existing[i];
      if (comm.messageId && wanted.has(comm.messageId)) {
        return comm.threadId ?? comm.id;
      }
    }
  }
  return selfId;
}

// RFC Message-ID for an app-sent message: deterministic per communication
// document so outbound mail carries threading identity even if the
// provider's assigned id is needed for API lookups.
export function outboundMessageId(
  communicationId: string,
  fromDomain: string
): string {
  return `<${communicationId}@${fromDomain}>`;
}

// Domain part of a "Name <addr@dom>" or bare "addr@dom" sender string —
// used to build RFC Message-IDs on the sending domain.
export function senderDomain(from: string): string {
  const angle = from.lastIndexOf("<");
  const address =
    angle >= 0 ? from.slice(angle + 1, from.indexOf(">", angle)) : from;
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).trim() : "localhost";
}

// --- Staff notification targeting ---

// Who gets the "customer replied" email: the assigned owner's adminUsers
// email when there is an active owner, else the shared trade mailbox.
// The owner's address comes from the admin identity record — it is never
// duplicated onto the lead.
export function replyNotificationRecipient(
  ownerEmail: string | undefined | null,
  fallbackEmail: string | undefined | null
): string | undefined {
  const owner = ownerEmail?.trim();
  if (owner) return owner;
  const fallback = fallbackEmail?.trim();
  return fallback || undefined;
}

export function serializeTradeLeadCommunication(
  id: string,
  data: Record<string, unknown>
): TradeLeadCommunicationView {
  const optStr = (key: string) => {
    const v = data[key];
    return typeof v === "string" && v ? v : undefined;
  };
  const rawAttachments = Array.isArray(data.attachments)
    ? (data.attachments as Record<string, unknown>[])
    : [];
  return {
    id,
    channel: optStr("channel") ?? "email",
    direction: data.direction === "inbound" ? "inbound" : "outbound",
    from: optStr("from"),
    to: strArray(data.to),
    cc: strArray(data.cc),
    subject: optStr("subject"),
    textBody: optStr("textBody"),
    truncated: data.truncated === true || undefined,
    attachments: rawAttachments
      .filter((a) => a && typeof a === "object" && !Array.isArray(a))
      .map((a) => ({
        providerAttachmentId:
          typeof a.providerAttachmentId === "string" && a.providerAttachmentId
            ? a.providerAttachmentId
            : undefined,
        filename:
          typeof a.filename === "string" && a.filename ? a.filename : undefined,
        contentType:
          typeof a.contentType === "string" && a.contentType
            ? a.contentType
            : undefined,
        size:
          typeof a.size === "number" && Number.isFinite(a.size)
            ? a.size
            : undefined,
      })),
    providerEmailId: optStr("providerEmailId"),
    messageId: optStr("messageId"),
    threadId: optStr("threadId"),
    sentAt: toIsoString(data.sentAt),
    receivedAt: toIsoString(data.receivedAt),
    sentByName: optStr("sentByName"),
    deliveryState: optStr("deliveryState"),
    deliveryDetails: optStr("deliveryDetails"),
    createdAt: toIsoString(data.createdAt),
  };
}
