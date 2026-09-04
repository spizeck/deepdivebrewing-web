import type { AdminInvitation, AdminRole } from "@/lib/admin-types";

export interface ResendEmailResult {
  ok: true;
  messageId: string;
}

export interface FailedEmailResult {
  ok: false;
  error: string;
}

export type SendEmailFunction = (
  email: string,
  role: AdminRole
) => Promise<ResendEmailResult | FailedEmailResult>;

export interface ResendInvitationCoreInput {
  invitation: AdminInvitation;
  sendEmail: SendEmailFunction;
  recordDelivery: (
    id: string,
    status: "sent" | "failed",
    messageId?: string
  ) => Promise<void>;
  audit: (metadata: Record<string, unknown>) => Promise<void>;
  logError: (message: string, error?: unknown) => void;
}

export interface ResendInvitationCoreResult {
  ok: true;
  emailSent: boolean;
  deliveryRecorded: boolean;
  messageId?: string;
  warning?: string;
}

export async function runResendInvitationCore(
  input: ResendInvitationCoreInput
): Promise<ResendInvitationCoreResult> {
  const { invitation, sendEmail, recordDelivery, audit, logError } = input;

  const emailResult = await sendEmail(invitation.email, invitation.role);

  let deliveryRecorded = true;
  try {
    await recordDelivery(
      invitation.id,
      emailResult.ok ? "sent" : "failed",
      emailResult.ok ? emailResult.messageId : undefined
    );
  } catch (recordError) {
    deliveryRecorded = false;
    logError("Failed to record invitation email delivery", recordError);
  }

  const auditMetadata: Record<string, unknown> = {
    invitationId: invitation.id,
    targetEmail: invitation.email,
    role: invitation.role,
    emailSent: emailResult.ok,
    messageId: emailResult.ok ? emailResult.messageId : undefined,
    deliveryRecorded,
  };
  if (!emailResult.ok) {
    auditMetadata.error = emailResult.error;
  }

  try {
    await audit(auditMetadata);
  } catch (auditError) {
    logError("Failed to write resend_invitation audit", auditError);
  }

  if (emailResult.ok) {
    if (deliveryRecorded) {
      return {
        ok: true,
        emailSent: true,
        deliveryRecorded: true,
        messageId: emailResult.messageId,
      };
    }
    return {
      ok: true,
      emailSent: true,
      deliveryRecorded: false,
      messageId: emailResult.messageId,
      warning:
        "The email was sent, but the delivery status could not be saved. The invitation remains pending.",
    };
  }

  if (deliveryRecorded) {
    return {
      ok: true,
      emailSent: false,
      deliveryRecorded: true,
      warning:
        "The email could not be sent. The failed status was recorded and the invitation remains pending.",
    };
  }

  return {
    ok: true,
    emailSent: false,
    deliveryRecorded: false,
    warning:
      "The email could not be sent and the failed status could not be recorded. The invitation remains pending.",
  };
}
