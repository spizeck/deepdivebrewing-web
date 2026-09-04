import type { AdminInvitation } from "@/lib/admin-types";

export interface ResendInvitationCheck {
  ok: boolean;
  reason?: string;
}

function getDefaultCooldownMs(): number {
  const configured = process.env.ADMIN_INVITE_RESEND_COOLDOWN_MS;
  if (configured) {
    const parsed = Number(configured);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 60_000; // 1 minute
}

export function canResendInvitation(
  invitation: AdminInvitation,
  now: number
): ResendInvitationCheck {
  if (invitation.status !== "pending") {
    return { ok: false, reason: "Only pending invitations can be resent." };
  }

  const lastAttempt = invitation.lastEmailAttemptAt;
  if (lastAttempt) {
    const lastAttemptMillis =
      typeof (lastAttempt as { toMillis?: () => number }).toMillis === "function"
        ? (lastAttempt as { toMillis: () => number }).toMillis()
        : new Date(String(lastAttempt)).getTime();

    if (!Number.isNaN(lastAttemptMillis)) {
      const elapsed = now - lastAttemptMillis;
      const cooldownMs = getDefaultCooldownMs();
      if (elapsed < cooldownMs) {
        const remainingSeconds = Math.ceil((cooldownMs - elapsed) / 1000);
        return {
          ok: false,
          reason: `Please wait ${remainingSeconds} second(s) before resending this invitation.`,
        };
      }
    }
  }

  return { ok: true };
}
