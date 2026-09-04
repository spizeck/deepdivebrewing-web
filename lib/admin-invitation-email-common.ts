export interface AdminInvitationEmail {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function buildAdminInvitationEmail(options: {
  to: string;
  from: string;
  role: string;
  adminUrl: string;
}): AdminInvitationEmail {
  const { to, from, role, adminUrl } = options;
  const safeTo = escapeHtml(to);
  const safeRole = escapeHtml(role);
  const safeAdminUrl = adminUrl;

  const subject = "You have been invited to Deep Dive Brewing Co";

  const html = `
    <div style="font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h1 style="font-size: 24px; margin-bottom: 16px;">Deep Dive Brewing Co</h1>
      <p>You have been invited to join the Deep Dive Brewing Co admin dashboard as a <strong>${safeRole}</strong>.</p>
      <p style="margin: 24px 0;">
        <a href="${safeAdminUrl}" style="display: inline-block; padding: 12px 24px; background-color: #1a1a1a; color: #ffffff; text-decoration: none; border-radius: 6px; font-weight: 600;">Go to admin dashboard</a>
      </p>
      <p>Sign in with the exact Google account you were invited with: <strong>${safeTo}</strong></p>
      <p style="color: #737373; font-size: 14px;">Your access will not be granted until you accept this invitation by signing in at the admin dashboard. Do not share this link.</p>
    </div>
  `.trim();

  const text = `Deep Dive Brewing Co

You have been invited to join the Deep Dive Brewing Co admin dashboard as a ${role}.

Go to the admin dashboard: ${adminUrl}

Sign in with the exact Google account you were invited with: ${to}

Your access will not be granted until you accept this invitation by signing in at the admin dashboard. Do not share this link.
`.trim();

  return {
    to,
    from,
    subject,
    html,
    text,
  };
}
