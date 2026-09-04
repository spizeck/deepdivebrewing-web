import { describe, it } from "node:test";
import assert from "node:assert";
import { evaluateInvitationAcceptance } from "@/lib/admin-invitation-policy";
import type { AdminUserRecord, AdminInvitation } from "@/lib/admin-types";

function record(overrides: Partial<AdminUserRecord> = {}): AdminUserRecord {
  return {
    uid: "uid-123",
    email: "a@example.com",
    displayName: "Admin",
    role: "admin",
    status: "active",
    createdAt: {} as FirebaseFirestore.Timestamp,
    createdBy: "inviter",
    ...overrides,
  } as AdminUserRecord;
}

function invitation(role: "admin" | "superadmin" = "admin"): AdminInvitation {
  return {
    id: "invite-1",
    email: "a@example.com",
    role,
    status: "pending",
    invitedBy: "inviter",
    createdAt: {} as FirebaseFirestore.Timestamp,
  };
}

describe("evaluateInvitationAcceptance", () => {
  it("proceeds when there is no existing admin record", () => {
    const result = evaluateInvitationAcceptance({
      existingRecord: null,
      invitation: invitation(),
      existingClaims: null,
      isProtectedEmail: false,
      isEmailVerified: true,
    });
    assert.strictEqual(result.decision, "proceed");
    assert.strictEqual(result.role, "admin");
    assert.strictEqual(result.recordExists, false);
    assert.strictEqual(result.idempotent, false);
  });

  it("proceeds idempotently when the active record already matches the invitation role", () => {
    const result = evaluateInvitationAcceptance({
      existingRecord: record({ role: "admin" }),
      invitation: invitation("admin"),
      existingClaims: null,
      isProtectedEmail: false,
      isEmailVerified: true,
    });
    assert.strictEqual(result.decision, "proceed");
    assert.strictEqual(result.idempotent, true);
    assert.strictEqual(result.recordExists, true);
  });

  it("rejects when the email is not verified", () => {
    const result = evaluateInvitationAcceptance({
      existingRecord: null,
      invitation: invitation(),
      existingClaims: null,
      isProtectedEmail: false,
      isEmailVerified: false,
    });
    assert.strictEqual(result.decision, "reject");
    assert.strictEqual(result.status, 403);
  });

  it("rejects when there is no pending invitation", () => {
    const result = evaluateInvitationAcceptance({
      existingRecord: null,
      invitation: null,
      existingClaims: null,
      isProtectedEmail: false,
      isEmailVerified: true,
    });
    assert.strictEqual(result.decision, "reject");
    assert.strictEqual(result.status, 404);
  });

  it("rejects when the email is the protected bootstrap superadmin", () => {
    const result = evaluateInvitationAcceptance({
      existingRecord: null,
      invitation: invitation(),
      existingClaims: null,
      isProtectedEmail: true,
      isEmailVerified: true,
    });
    assert.strictEqual(result.decision, "reject");
    assert.strictEqual(result.status, 403);
  });

  it("rejects when the existing admin record is disabled", () => {
    const result = evaluateInvitationAcceptance({
      existingRecord: record({ status: "disabled" }),
      invitation: invitation(),
      existingClaims: null,
      isProtectedEmail: false,
      isEmailVerified: true,
    });
    assert.strictEqual(result.decision, "reject");
    assert.strictEqual(result.status, 409);
  });

  it("rejects when the active record has a different role than the invitation", () => {
    const result = evaluateInvitationAcceptance({
      existingRecord: record({ role: "admin" }),
      invitation: invitation("superadmin"),
      existingClaims: null,
      isProtectedEmail: false,
      isEmailVerified: true,
    });
    assert.strictEqual(result.decision, "reject");
    assert.strictEqual(result.status, 409);
  });

  it("rejects a disabled admin even when the invitation is for superadmin", () => {
    const result = evaluateInvitationAcceptance({
      existingRecord: record({ status: "disabled", role: "admin" }),
      invitation: invitation("superadmin"),
      existingClaims: null,
      isProtectedEmail: false,
      isEmailVerified: true,
    });
    assert.strictEqual(result.decision, "reject");
    assert.strictEqual(result.status, 409);
  });
});
