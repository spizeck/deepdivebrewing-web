import { describe, it } from "node:test";
import assert from "node:assert";
import { canResendInvitation } from "@/lib/admin-invitation-resend-policy";
import type { AdminInvitation } from "@/lib/admin-types";

function stubTimestamp(millis: number) {
  return { toMillis: () => millis } as unknown as AdminInvitation["lastEmailAttemptAt"];
}

describe("canResendInvitation", () => {
  const baseInvitation: AdminInvitation = {
    id: "inv-1",
    email: "pending@example.com",
    role: "admin",
    status: "pending",
    invitedBy: "uid-creator",
    createdAt: stubTimestamp(0) as unknown as AdminInvitation["createdAt"],
  };

  it("allows resending a pending invitation that has never been emailed", () => {
    const result = canResendInvitation(baseInvitation, Date.now());
    assert.strictEqual(result.ok, true);
  });

  it("rejects resending an accepted invitation", () => {
    const invitation: AdminInvitation = { ...baseInvitation, status: "accepted" };
    const result = canResendInvitation(invitation, Date.now());
    assert.strictEqual(result.ok, false);
    assert.match(result.reason ?? "", /Only pending/i);
  });

  it("rejects resending a cancelled invitation", () => {
    const invitation: AdminInvitation = { ...baseInvitation, status: "cancelled" };
    const result = canResendInvitation(invitation, Date.now());
    assert.strictEqual(result.ok, false);
    assert.match(result.reason ?? "", /Only pending/i);
  });

  it("rejects resending within the default cooldown", () => {
    const now = 1_000_000;
    const invitation: AdminInvitation = {
      ...baseInvitation,
      lastEmailAttemptAt: stubTimestamp(now - 5_000) as unknown as AdminInvitation["lastEmailAttemptAt"],
    };
    const result = canResendInvitation(invitation, now);
    assert.strictEqual(result.ok, false);
    assert.match(result.reason ?? "", /wait/i);
  });

  it("allows resending after the default cooldown", () => {
    const now = 1_000_000;
    const invitation: AdminInvitation = {
      ...baseInvitation,
      lastEmailAttemptAt: stubTimestamp(now - 120_000) as unknown as AdminInvitation["lastEmailAttemptAt"],
    };
    const result = canResendInvitation(invitation, now);
    assert.strictEqual(result.ok, true);
  });
});
