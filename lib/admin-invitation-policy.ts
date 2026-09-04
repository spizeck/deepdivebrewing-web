import type { AdminRole, AdminUserRecord, AdminInvitation } from "@/lib/admin-types";
import type { AdminClaims } from "@/lib/admin-common";

export interface InvitationAcceptanceCheck {
  existingRecord: AdminUserRecord | null;
  invitation: AdminInvitation | null;
  existingClaims: AdminClaims | null;
  isProtectedEmail: boolean;
  isEmailVerified: boolean;
}

export interface InvitationAcceptanceProceed {
  decision: "proceed";
  role: AdminRole;
  idempotent: boolean;
  recordExists: boolean;
}

export interface InvitationAcceptanceReject {
  decision: "reject";
  status: number;
  error: string;
}

export type InvitationAcceptanceResult =
  | InvitationAcceptanceProceed
  | InvitationAcceptanceReject;

export function evaluateInvitationAcceptance(
  check: InvitationAcceptanceCheck
): InvitationAcceptanceResult {
  if (!check.isEmailVerified) {
    return {
      decision: "reject",
      status: 403,
      error: "Email must be verified to accept an invitation.",
    };
  }

  if (!check.invitation) {
    return {
      decision: "reject",
      status: 404,
      error: "No pending invitation was found for this account.",
    };
  }

  if (check.isProtectedEmail) {
    return {
      decision: "reject",
      status: 403,
      error: "This account cannot accept an invitation.",
    };
  }

  if (check.existingRecord?.status === "disabled") {
    return {
      decision: "reject",
      status: 409,
      error:
        "This account is disabled. Ask a superadmin to reactivate it from the Access panel.",
    };
  }

  if (check.existingRecord?.status === "active") {
    if (check.existingRecord.role !== check.invitation.role) {
      return {
        decision: "reject",
        status: 409,
        error:
          "This account already has administrator access with a different role. Ask a superadmin to change your role.",
      };
    }

    return {
      decision: "proceed",
      role: check.existingRecord.role,
      idempotent: true,
      recordExists: true,
    };
  }

  return {
    decision: "proceed",
    role: check.invitation.role,
    idempotent: false,
    recordExists: false,
  };
}
