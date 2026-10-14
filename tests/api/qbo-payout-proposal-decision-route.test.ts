import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { NextRequest } from "next/server";

// Route-level coverage for POST /api/admin/quickbooks/payouts/proposals:
// bearer + accounting-permission gate, body validation, error mapping,
// and the audit-log contract. The decision engine is module-mocked —
// lib tests cover its transition rules.

mock.module("server-only", { namedExports: {} });

const decideCalls: Record<string, unknown>[] = [];
let decideResult: Record<string, unknown> = {
  proposalId: "sandbox:po_1:move_payment_to_clearing:42",
  status: "approved",
  changed: true,
};
let decideError:
  | (Error & { clientSafe?: boolean; status?: number })
  | null = null;

mock.module("@/lib/stripe-payout-decisions", {
  namedExports: {
    decidePayoutProposal: async (input: Record<string, unknown>) => {
      if (decideError) throw decideError;
      decideCalls.push(input);
      return decideResult;
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

const PATH = "/api/admin/quickbooks/payouts/proposals";

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
  decideCalls.length = 0;
  auditCalls.length = 0;
  requestedPermissions.length = 0;
  adminError = null;
  decideError = null;
  decideResult = {
    proposalId: "sandbox:po_1:move_payment_to_clearing:42",
    status: "approved",
    changed: true,
  };
});

describe("POST /api/admin/quickbooks/payouts/proposals", () => {
  it("rejects unauthenticated calls", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/route"
    );
    const res = await POST(
      new NextRequest(`https://deepdivebrewing.com${PATH}`, {
        method: "POST",
      })
    );
    assert.strictEqual(res.status, 401);
    assert.strictEqual(decideCalls.length, 0);
  });

  it("requires the accounting capability", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/route"
    );
    adminError = {
      message: 'This action requires the "accounting" admin permission.',
      status: 403,
    };
    const res = await POST(
      authedPost(
        JSON.stringify({
          proposalId: "sandbox:po_1:k:1",
          action: "approve",
          expectedFingerprint: "fp-1",
        })
      )
    );
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(requestedPermissions, ["accounting"]);
    assert.strictEqual(decideCalls.length, 0);
  });

  it("records an approval and audits it", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/route"
    );
    const res = await POST(
      authedPost(
        JSON.stringify({
          proposalId: "sandbox:po_1:k:1",
          action: "approve",
          note: "verified against Ollie",
          expectedFingerprint: "fp-1",
        })
      )
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.result.status, "approved");
    assert.deepStrictEqual(body.view, { view: true });
    assert.strictEqual(decideCalls.length, 1);
    assert.strictEqual(decideCalls[0].action, "approve");
    assert.strictEqual(decideCalls[0].note, "verified against Ollie");
    // The reviewed fingerprint is forwarded — the decision layer binds
    // to the facts the admin actually saw.
    assert.strictEqual(decideCalls[0].expectedFingerprint, "fp-1");
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(
      auditCalls[0].action,
      "stripe_payout_proposal_approved"
    );
  });

  it("validates action, proposalId, and expectedFingerprint", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/route"
    );
    const bad = await POST(
      authedPost(
        JSON.stringify({
          proposalId: "x",
          action: "maybe",
          expectedFingerprint: "fp-1",
        })
      )
    );
    assert.strictEqual(bad.status, 400);
    const missing = await POST(
      authedPost(
        JSON.stringify({ action: "approve", expectedFingerprint: "fp-1" })
      )
    );
    assert.strictEqual(missing.status, 400);
    const noFingerprint = await POST(
      authedPost(
        JSON.stringify({ proposalId: "sandbox:po_1:k:1", action: "approve" })
      )
    );
    assert.strictEqual(noFingerprint.status, 400);
    const badJson = await POST(authedPost("{not json"));
    assert.strictEqual(badJson.status, 400);
    assert.strictEqual(decideCalls.length, 0);
  });

  it("propagates the observe-mode refusal as a 409", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/route"
    );
    decideError = Object.assign(
      new Error(
        "Proposal decisions require accounting approval mode — the deployment is in observe mode."
      ),
      { clientSafe: true, status: 409 }
    );
    const res = await POST(
      authedPost(
        JSON.stringify({
          proposalId: "sandbox:po_1:k:1",
          action: "reject",
          expectedFingerprint: "fp-1",
        })
      )
    );
    assert.strictEqual(res.status, 409);
  });

  it("answers a safe 500 for unexpected failures", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/proposals/route"
    );
    decideError = new Error("firestore: unknown");
    const res = await POST(
      authedPost(
        JSON.stringify({
          proposalId: "sandbox:po_1:k:1",
          action: "approve",
          expectedFingerprint: "fp-1",
        })
      )
    );
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.strictEqual(
      body.error,
      "The proposal decision could not be recorded."
    );
  });
});
