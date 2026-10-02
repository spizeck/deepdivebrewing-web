// Pure configuration lookup for the Resend client. Kept separate from
// lib/resend.ts (which is server-only) so the validation is unit-testable.
export function getResendApiKey(): string {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Resend API key is not configured (RESEND_API_KEY).");
  }
  return apiKey;
}

// Verified Resend sending domain for this project is mail.deepdivebrewing.com
// (Vercel-managed Resend integration). The integration also injects
// RESEND_EMAIL_DOMAIN, which we intentionally do not consume — explicit
// sender addresses (display name + local part) are clearer than composing
// one from the domain.
export const DEFAULT_RESEND_FROM_EMAIL =
  "Deep Dive Brewing <noreply@mail.deepdivebrewing.com>";

// Shared default sender (trade inquiries; last-resort sender for admin
// invitations). RESEND_FROM_EMAIL overrides; otherwise the verified-domain
// default above is used.
export function getDefaultFromEmail(): string {
  return process.env.RESEND_FROM_EMAIL?.trim() || DEFAULT_RESEND_FROM_EMAIL;
}

// Preferred sender for admin invitation emails: dedicated override, then the
// shared sender variable, then the verified-domain default.
export function getAdminInviteFromEmail(): string {
  return (
    process.env.ADMIN_INVITE_FROM_EMAIL?.trim() || getDefaultFromEmail()
  );
}

// Sender for customer-facing trade-lead email (#152): dedicated override,
// then the shared sender variable, then a conversational address on the
// verified domain — deliberately not the noreply@ default, since these
// messages start a real thread (replies route through TRADE_REPLY_DOMAIN).
export function getTradeFromEmail(): string {
  return (
    process.env.TRADE_FROM_EMAIL?.trim() ||
    process.env.RESEND_FROM_EMAIL?.trim() ||
    "Deep Dive Brewing <trade@mail.deepdivebrewing.com>"
  );
}

// Operational mailbox that receives staff notifications (new trade inquiry,
// customer replies on unassigned leads). TRADE_NOTIFICATION_EMAIL is the
// canonical variable; TRADE_INQUIRY_TO_EMAIL is the legacy name kept as a
// fallback so an un-migrated deployment keeps notifying.
export function getTradeNotificationEmail(): string | undefined {
  return (
    process.env.TRADE_NOTIFICATION_EMAIL?.trim() ||
    process.env.TRADE_INQUIRY_TO_EMAIL?.trim() ||
    undefined
  );
}

// Domain for per-lead inbound addresses (<token>@<domain>). Requires the
// domain to be configured for inbound email in Resend (MX records) — see
// docs/operations. Defaults to reply.deepdivebrewing.com.
export function getInboundReplyDomain(): string {
  return (
    process.env.TRADE_REPLY_DOMAIN?.trim() || "reply.deepdivebrewing.com"
  );
}

// Signing secret (whsec_…) for the Resend webhook endpoint. Unset means the
// endpoint is not configured — it must refuse work rather than process
// unverified events.
export function getResendWebhookSecret(): string | undefined {
  return process.env.RESEND_WEBHOOK_SECRET?.trim() || undefined;
}
