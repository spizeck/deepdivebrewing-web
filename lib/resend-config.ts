// Pure configuration lookup for the Resend client. Kept separate from
// lib/resend.ts (which is server-only) so the validation is unit-testable.
export function getResendApiKey(): string {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Resend API key is not configured (RESEND_API_KEY).");
  }
  return apiKey;
}
