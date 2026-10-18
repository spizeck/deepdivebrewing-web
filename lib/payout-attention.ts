import "server-only";
import { createHash } from "node:crypto";
import { getResendClient } from "@/lib/resend";
import {
  getDefaultFromEmail,
  getTradeNotificationEmail,
} from "@/lib/resend-config";
import { siteUrl } from "@/lib/site";
import { logInfo, logWarn } from "@/lib/log";

// Payout-attention notification — the "I am interrupted only for genuine
// exceptions" half of automatic mode. A payout earns a notification when
// it carries actionable exceptions or an auto-apply pass left retryable
// work; the dedup key on the payout doc makes repeat deliveries of an
// unchanged exception set a no-op, so the same unresolved problem never
// emails twice and a resolved-then-new problem does.
//
// `cutover_skipped` is informational context (it marks pre-automation
// history on every legacy payout) — notifying on it would spam the inbox
// at activation with nothing to act on, so it never counts as attention.
const INFORMATIONAL_EXCEPTION_CODES = new Set(["cutover_skipped"]);

export interface PayoutAttentionException {
  code: string;
  ref?: string;
  detail?: string;
  amountMinor?: number;
}

export interface PayoutAttentionInput {
  payoutId: string;
  amountMinor: number;
  currency: string;
  arrivalDate?: string;
  exceptions: PayoutAttentionException[];
  /** Auto-apply outcomes still outstanding after this build. */
  autoApplied?: number;
  autoPending?: number;
}

export interface PayoutAttentionEmail {
  to: string;
  subject: string;
  text: string;
}

function actionableExceptions(
  exceptions: PayoutAttentionException[]
): PayoutAttentionException[] {
  return exceptions.filter(
    (exception) => !INFORMATIONAL_EXCEPTION_CODES.has(exception.code)
  );
}

// Returns null when no actionable exception exists — pure function so
// the dedup contract is testable without Firestore or Resend. The key
// covers the exception signature only; pending auto-apply work is
// tracked separately (attentionPending on the payout doc) so a retry
// resolving transiently does not re-send an email for an unchanged
// exception set.
export function payoutAttentionKey(input: PayoutAttentionInput): string | null {
  const actionable = actionableExceptions(input.exceptions);
  if (actionable.length === 0) return null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        p: input.payoutId,
        a: input.amountMinor,
        c: input.currency,
        e: actionable
          .map((exception) => `${exception.code}@${exception.ref ?? ""}`)
          .sort(),
      })
    )
    .digest("hex")
    .slice(0, 24);
}

// Recipient: the dedicated accounting-attention address when configured,
// else the existing staff notification mailbox. Absent both, no send.
export function getPayoutAttentionEmail(): string | undefined {
  return (
    process.env.PAYOUT_ATTENTION_EMAIL?.trim() || getTradeNotificationEmail()
  );
}

export function buildPayoutAttentionEmail(
  input: PayoutAttentionInput,
  to: string
): PayoutAttentionEmail {
  const amount = `${(input.amountMinor / 100).toFixed(2)} ${input.currency}`;
  const actionable = actionableExceptions(input.exceptions);
  const appliedNote =
    (input.autoApplied ?? 0) > 0
      ? `${input.autoApplied} proposal(s) were already applied to QuickBooks for this payout — review the applied entries alongside the exceptions.\n`
      : "No accounting entries were applied to QuickBooks for this payout.\n";
  const lines = actionable
    .map(
      (exception) =>
        `  - ${exception.code} [${exception.ref ?? "payout"}]: ${exception.detail ?? ""}`
    )
    .join("\n");
  const pendingNote =
    (input.autoPending ?? 0) > 0
      ? `\n${input.autoPending} automatic write(s) are still pending — transient failures retry on the daily sweep; check the proposal's execution state.`
      : "";
  return {
    to,
    subject: `Stripe payout needs review: ${amount} (${input.payoutId})`,
    text: [
      `Stripe payout ${input.payoutId} (${amount}, arrived ${input.arrivalDate ?? "unknown"}) could not be fully accounted for automatically.`,
      "",
      "Exceptions:",
      lines || "  - (none listed)",
      pendingNote,
      "",
      appliedNote,
      `Review and decide at: ${siteUrl}/admin/integrations/quickbooks`,
      "",
      "Safe next action: open the payout card, read the exception detail, and approve or correct the affected proposal. The exceptions above stay unposted until then; verified entries may already have posted automatically.",
    ].join("\n"),
  };
}

// Sends the attention email. Returns "sent" or "skipped" (no recipient
// configured). Resend reports API failures in `error` rather than
// throwing — normalize those to a throw so the caller only records the
// notification as delivered when the provider actually accepted it.
// Throws propagate — the caller wraps this in its own failure boundary
// so a mail outage can never break ledger processing.
export async function sendPayoutAttentionEmail(
  input: PayoutAttentionInput
): Promise<"sent" | "skipped"> {
  const to = getPayoutAttentionEmail();
  if (!to) {
    logWarn("stripe.payout.attention_no_recipient", {
      payoutId: input.payoutId,
    });
    return "skipped";
  }
  const email = buildPayoutAttentionEmail(input, to);
  const { error } = await getResendClient().emails.send({
    from: getDefaultFromEmail(),
    to: email.to,
    subject: email.subject,
    text: email.text,
  });
  if (error) {
    throw new Error(`resend.emails.send failed: ${error.name}`);
  }
  logInfo("stripe.payout.attention_notified", { payoutId: input.payoutId });
  return "sent";
}
