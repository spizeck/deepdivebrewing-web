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
