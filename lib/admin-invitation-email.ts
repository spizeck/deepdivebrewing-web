import "server-only";
import { buildAdminInvitationEmail } from "@/lib/admin-invitation-email-common";
import { getResendClient } from "@/lib/resend";
import { getAdminInviteFromEmail } from "@/lib/resend-config";
import { logError } from "@/lib/log";
import type {
  ResendEmailResult,
  FailedEmailResult,
  SendEmailFunction,
} from "@/lib/admin-invitation-resend-core";

export type SendAdminInvitationEmailResult =
  | ResendEmailResult
  | FailedEmailResult;

export type { ResendEmailResult, FailedEmailResult, SendEmailFunction };

export { getAdminInviteFromEmail };

export function getAdminSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL ?? "https://deepdivebrewing.com";
  return raw.replace(/\/+$/, "");
}

export const sendAdminInvitationEmail: SendEmailFunction = async (
  email,
  role
) => {
  const apiKey = process.env.RESEND_API_KEY;
  const from = getAdminInviteFromEmail();

  if (!apiKey) {
    logError("admin_invitation_email.misconfigured", undefined, {
      missing: "RESEND_API_KEY",
    });
    return { ok: false, error: "Email service is not configured." };
  }

  const resend = getResendClient();
  const adminUrl = `${getAdminSiteUrl()}/admin`;

  const { to, from: fromAddress, subject, html, text } = buildAdminInvitationEmail(
    {
      to: email,
      from,
      role,
      adminUrl,
    }
  );

  try {
    const { data, error } = await resend.emails.send({
      from: fromAddress,
      to,
      subject,
      html,
      text,
    });

    if (error) {
      logError("admin_invitation_email.send_rejected", error);
      return { ok: false, error: "Resend rejected the email request." };
    }

    if (!data?.id) {
      return { ok: false, error: "Resend did not return a message identifier." };
    }

    return { ok: true, messageId: data.id };
  } catch (sendError) {
    logError("admin_invitation_email.send_exception", sendError);
    return {
      ok: false,
      error: "An unexpected error occurred while sending the invitation email.",
    };
  }
}
