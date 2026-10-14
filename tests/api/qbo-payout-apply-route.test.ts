import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { NextRequest } from "next/server";

// Route-level coverage for POST .../payouts/proposals/apply: bearer +
// accounting permission, body validation, structured outcome pass-
// through, audit logging, and error mapping. The executor's guards and
// QBO semantics are covered by tests/lib/stripe-payout-executor.test.ts.

mock.module("server-only", { namedExports: {} });

const applyCalls: Record<string, unknown>[] = [];
let applyResult: Record<string, unknown> = {
  proposalId: "sandbox:po_1:k:1",
  apply: {
    outcome: "applied",
    qboEntityType: "Transfer",
    qboEntityId: "tr-1",
    adopted: false,
  },
};
let applyError: (Error & { clientSafe?: boolean }) | null = null;

mock.module("@/lib/stripe-payout-executor", {
  namedExports: {
    applyPayoutProposal: async (input: Record<string, unknown>) => {
      if (applyError) throw applyError;
      applyCalls.push(input);
      return applyResult;
    },
  },
});

mock.module("@/lib/stripe-payouts", {
  namedExports: {
    getStripePayoutAutomationView: async () => ({ view: true }),
  },
});

let adminError: { message: string; status: number } | null = null;
const requestedPermissions: string[] = [];

mock.module("@/lib/admin-auth", {
  namedExports: {
    requireAdminPermission: async (_idToken: string, permission: string) => {
      requestedPermissions.push(permission);
      if (adminError) {
        throw Object.assign(new Error(adminError.message), {
          clientSafe: true,
          status: adminError.status,
        });
      }
      return {
        token: { uid: "admin-1", email: "admin@example.test" },
        claims: { admin: true, role: "admin" },
        record: { uid: "admin-1", email: "admin@example.test" },
      };
    },
  },
});

const auditCalls: Record<string, unknown>[] = [];
mock.module("@/lib/admin-audit", {
  namedExports: {
    logAdminAudit: async (record: Record<string, unknown>) => {
      auditCalls.push(record);
    },
  },
});

mock.module("@/lib/log", {
  namedExports: {
    logInfo: () => {},
    logWarn: () => {},
    logError: () => {},
    getRequestId: () => "req-test",
  },
});

const PATH = "/api/admin/quickbooks/payouts/proposals/apply";

function authedPost(body?: string): NextRequest {
  return new NextRequest(`https://deepdivebrewing.com${PATH}`, {
    method: "POST",
    headers: {
      authorization: "Bearer id-token",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}

beforeEach(() => {
  applyCalls.length = 0;
  auditCalls.length = 0;
  requestedPermissions.length = 0;
  adminError = null;
  applyError = null;
  applyResult = {
    proposalId: "sandbox:po_1:k:1",
    apply: {
      outcome: "applied",
      qboEntityType: "Transfer",
      qboEntityId: "tr-1",
      adopted: false,
    },
  };
});

describe("POST /api/admin/quickbooks/payouts/proposals/apply", () => {
  it("rejects unauthenticated calls", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/apply/route"
    );
    const res = await POST(
      new NextRequest(`https://deepdivebrewing.com${PATH}`, {
        method: "POST",
      })
    );
    assert.strictEqual(res.status, 401);
    assert.strictEqual(applyCalls.length, 0);
  });

  it("requires the accounting capability", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/apply/route"
    );
    adminError = {
      message: 'This action requires the "accounting" admin permission.',
      status: 403,
    };
    const res = await POST(
      authedPost(JSON.stringify({ proposalId: "sandbox:po_1:k:1" }))
    );
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(requestedPermissions, ["accounting"]);
    assert.strictEqual(applyCalls.length, 0);
  });

  it("validates the body", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/apply/route"
    );
    const missing = await POST(authedPost(JSON.stringify({})));
    assert.strictEqual(missing.status, 400);
    const badJson = await POST(authedPost("{bad"));
    assert.strictEqual(badJson.status, 400);
    assert.strictEqual(applyCalls.length, 0);
  });

  it("returns the applied outcome with entity refs and audits it", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/apply/route"
    );
    const res = await POST(
      authedPost(JSON.stringify({ proposalId: "sandbox:po_1:k:1" }))
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.result.apply.outcome, "applied");
    assert.strictEqual(body.result.apply.qboEntityId, "tr-1");
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(
      auditCalls[0].action,
      "stripe_payout_proposal_apply"
    );
    assert.strictEqual(
      (auditCalls[0].metadata as Record<string, unknown>).qboEntityId,
      "tr-1"
    );
  });

  it("passes refused/uncertain verdicts through as structured results", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/apply/route"
    );
    for (const apply of [
      { outcome: "refused", reason: "payment_not_in_undeposited" },
      { outcome: "uncertain", message: "unknown write outcome" },
      { outcome: "in_progress" },
    ]) {
      applyResult = { proposalId: "sandbox:po_1:k:1", apply };
      const res = await POST(
        authedPost(JSON.stringify({ proposalId: "sandbox:po_1:k:1" }))
      );
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.result.apply.outcome, apply.outcome);
    }
  });

  it("propagates the observe-mode refusal as a 409", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/apply/route"
    );
    applyError = Object.assign(
      new Error(
        "Proposal execution requires a non-observe accounting mode — the deployment is in observe mode."
      ),
      { clientSafe: true, status: 409 }
    );
    const res = await POST(
      authedPost(JSON.stringify({ proposalId: "sandbox:po_1:k:1" }))
    );
    assert.strictEqual(res.status, 409);
  });

  it("answers a safe 500 for unexpected failures", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/apply/route"
    );
    applyError = new Error("firestore: unknown");
    const res = await POST(
      authedPost(JSON.stringify({ proposalId: "sandbox:po_1:k:1" }))
    );
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.strictEqual(body.error, "The proposal could not be applied.");
  });
});
