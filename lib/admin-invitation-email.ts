import "server-only";
import { Resend } from "resend";
import { buildAdminInvitationEmail } from "@/lib/admin-invitation-email-common";

export interface SentInvitationEmail {
  ok: true;
  messageId: string;
}

export interface FailedInvitationEmail {
  ok: false;
  error: string;
}

export type SendAdminInvitationEmailResult =
  | SentInvitationEmail
  | FailedInvitationEmail;

export function getAdminInviteFromEmail(): string | undefined {
  return (
    process.env.ADMIN_INVITE_FROM_EMAIL ??
    process.env.RESEND_FROM_EMAIL ??
    undefined
  );
}

export function getAdminSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL ?? "https://deepdivebrewing.com";
  return raw.replace(/\/+$/, "");
}

export async function sendAdminInvitationEmail(
  email: string,
  role: string
): Promise<SendAdminInvitationEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = getAdminInviteFromEmail();

  if (!apiKey) {
    console.error("Resend API key is not configured.");
    return { ok: false, error: "Email service is not configured." };
  }

  if (!from) {
    console.error("Admin invitation sender email is not configured.");
    return { ok: false, error: "Invitation sender email is not configured." };
  }

  const resend = new Resend(apiKey);
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
      console.error("Resend invitation email error:", error);
      return { ok: false, error: "Resend rejected the email request." };
    }

    if (!data?.id) {
      return { ok: false, error: "Resend did not return a message identifier." };
    }

    return { ok: true, messageId: data.id };
  } catch (sendError) {
    console.error("Resend invitation send exception:", sendError);
    return {
      ok: false,
      error: "An unexpected error occurred while sending the invitation email.",
    };
  }
}
