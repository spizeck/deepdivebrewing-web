import { describe, it } from "node:test";
import assert from "node:assert";
import {
  runResendInvitationCore,
  type ResendEmailResult,
  type FailedEmailResult,
} from "@/lib/admin-invitation-resend-core";
import type { AdminInvitation, AdminRole } from "@/lib/admin-types";

function makeInvitation(
  overrides: Partial<AdminInvitation> = {}
): AdminInvitation {
  return {
    id: "inv-1",
    email: "admin@example.com",
    role: "admin" as AdminRole,
    status: "pending",
    invitedBy: "uid-creator",
    createdAt: new Date("2025-01-01") as unknown as AdminInvitation["createdAt"],
    ...overrides,
  };
}

function makeSendEmail(
  result: ResendEmailResult | FailedEmailResult
): typeof import("@/lib/admin-invitation-resend-core").SendEmailFunction {
  return async () => result;
}

describe("runResendInvitationCore", () => {
  it("returns success when Resend succeeds and metadata recording succeeds", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await runResendInvitationCore({
      invitation: makeInvitation(),
      sendEmail: makeSendEmail({ ok: true, messageId: "msg-1" }),
      recordDelivery: async (id, status, messageId) => {
        calls.push({ id, status, messageId });
      },
      audit: async (metadata) => {
        calls.push({ type: "audit", metadata });
      },
      logError: () => undefined,
    });

    assert.deepStrictEqual(result, {
      ok: true,
      emailSent: true,
      deliveryRecorded: true,
      messageId: "msg-1",
    });
    assert.strictEqual(calls[0].status, "sent");
    assert.strictEqual(calls[0].messageId, "msg-1");
    assert.strictEqual(calls[1].type, "audit");
  });

  it("returns partial success when Resend succeeds but metadata recording fails", async () => {
    const result = await runResendInvitationCore({
      invitation: makeInvitation(),
      sendEmail: makeSendEmail({ ok: true, messageId: "msg-2" }),
      recordDelivery: async () => {
        throw new Error("Firestore unavailable");
      },
      audit: async () => undefined,
      logError: () => undefined,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.emailSent, true);
    assert.strictEqual(result.deliveryRecorded, false);
    assert.strictEqual(result.messageId, "msg-2");
    assert.match(result.warning ?? "", /email was sent, but the delivery status/i);
  });

  it("records failed status when Resend fails", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const result = await runResendInvitationCore({
      invitation: makeInvitation(),
      sendEmail: makeSendEmail({
        ok: false,
        error: "Resend rejected the email request.",
      }),
      recordDelivery: async (id, status, messageId) => {
        calls.push({ id, status, messageId });
      },
      audit: async (metadata) => {
        calls.push({ type: "audit", metadata });
      },
      logError: () => undefined,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.emailSent, false);
    assert.strictEqual(result.deliveryRecorded, true);
    assert.match(result.warning ?? "", /email could not be sent/i);
    assert.strictEqual(calls[0].status, "failed");
    assert.strictEqual(calls[0].messageId, undefined);
    assert.strictEqual(calls[1].type, "audit");
  });

  it("returns structured failure when Resend fails and metadata recording also fails", async () => {
    const result = await runResendInvitationCore({
      invitation: makeInvitation(),
      sendEmail: makeSendEmail({
        ok: false,
        error: "Resend rejected the email request.",
      }),
      recordDelivery: async () => {
        throw new Error("Firestore unavailable");
      },
      audit: async () => undefined,
      logError: () => undefined,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.emailSent, false);
    assert.strictEqual(result.deliveryRecorded, false);
    assert.match(
      result.warning ?? "",
      /email could not be sent and the failed status could not be recorded/i
    );
  });

  it("logs audit failures without changing the API response", async () => {
    const errors: string[] = [];
    const result = await runResendInvitationCore({
      invitation: makeInvitation(),
      sendEmail: makeSendEmail({ ok: true, messageId: "msg-3" }),
      recordDelivery: async () => undefined,
      audit: async () => {
        throw new Error("Audit write failed");
      },
      logError: (message) => {
        errors.push(message);
      },
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.emailSent, true);
    assert.strictEqual(result.deliveryRecorded, true);
    assert.ok(errors.some((m) => m.includes("resend_invitation audit")));
  });

  it("never exposes raw provider errors, credentials, or stack traces in the response", async () => {
    const result = await runResendInvitationCore({
      invitation: makeInvitation(),
      sendEmail: async () => ({
        ok: false as const,
        error: "api-key-12345 was rejected by smtp.resend.com at line 42",
      }),
      recordDelivery: async () => undefined,
      audit: async () => undefined,
      logError: () => undefined,
    });

    const response = JSON.stringify(result);
    assert.doesNotMatch(response, /api-key-12345/);
    assert.doesNotMatch(response, /resend\.com/);
    assert.doesNotMatch(response, /line 42/);
    assert.doesNotMatch(response, /Firestore/);
    assert.match(result.warning ?? "", /email could not be sent/i);
  });
});
