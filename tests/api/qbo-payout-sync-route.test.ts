import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { NextRequest } from "next/server";

// Route-level coverage for POST /api/admin/quickbooks/payouts/sync: the
// bearer + accounting-permission gate, body validation, conflict/error
// propagation, and the summary+view response contract. The payout engine
// itself is module-mocked — lib tests cover its behavior.

mock.module("server-only", { namedExports: {} });

const syncSummary: Record<string, unknown> = {
  environment: "sandbox",
  scope: "recent",
  discovered: 3,
  processed: 1,
  statusRecorded: 1,
  alreadyCurrent: 1,
  failed: 0,
  remaining: 0,
  scanTruncated: false,
  items: [],
};
const syncCalls: { payoutId?: string }[] = [];
let syncError: (Error & { clientSafe?: boolean; status?: number }) | null =
  null;

mock.module("@/lib/stripe-payouts", {
  namedExports: {
    syncStripePayouts: async (input: { payoutId?: string }) => {
      if (syncError) throw syncError;
      syncCalls.push(input);
      return syncSummary;
    },
    getStripePayoutAutomationView: async () => ({ view: true }),
    processStripePayoutLedger: async () => null,
    recordStripePayoutEvent: async () => ({ status: "ignored" }),
    runStripePayoutSweep: async () => ({}),
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

function req(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): NextRequest {
  return new NextRequest(`https://deepdivebrewing.com${url}`, init);
}

function authedPost(body?: string): NextRequest {
  return req("/api/admin/quickbooks/payouts/sync", {
    method: "POST",
    headers: {
      authorization: "Bearer id-token",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
}

beforeEach(() => {
  syncCalls.length = 0;
  auditCalls.length = 0;
  adminError = null;
  syncError = null;
  requestedPermissions.length = 0;
});

describe("POST /api/admin/quickbooks/payouts/sync", () => {
  it("rejects unauthenticated calls", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/sync/route"
    );
    const res = await POST(
      req("/api/admin/quickbooks/payouts/sync", { method: "POST" })
    );
    assert.strictEqual(res.status, 401);
    assert.strictEqual(syncCalls.length, 0);
  });

  it("enforces the admin actor check", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/sync/route"
    );
    adminError = {
      message: "This action requires administrator access.",
      status: 403,
    };
    const res = await POST(authedPost());
    assert.strictEqual(res.status, 403);
    assert.strictEqual(syncCalls.length, 0);
  });

  it("requires the accounting capability", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/sync/route"
    );
    adminError = {
      message: 'This action requires the "accounting" admin permission.',
      status: 403,
    };
    const res = await POST(authedPost());
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(requestedPermissions, ["accounting"]);
    assert.strictEqual(syncCalls.length, 0);
  });

  it("runs a recent-payout sync and returns the summary plus view", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/sync/route"
    );
    const res = await POST(authedPost(JSON.stringify({})));
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(body.summary, syncSummary);
    assert.deepStrictEqual(body.view, { view: true });
    assert.strictEqual(syncCalls.length, 1);
    assert.strictEqual(syncCalls[0].payoutId, undefined);
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(
      auditCalls[0].action,
      "stripe_payout_sync_triggered"
    );
  });

  it("passes a payoutId through for a single-payout sync", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/sync/route"
    );
    const res = await POST(
      authedPost(JSON.stringify({ payoutId: "po_1AbC" }))
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(syncCalls, [{ payoutId: "po_1AbC" }]);
  });

  it("rejects a non-JSON body and a malformed payoutId field", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/sync/route"
    );
    const badJson = await POST(authedPost("not-json{"));
    assert.strictEqual(badJson.status, 400);

    const badType = await POST(
      authedPost(JSON.stringify({ payoutId: 42 }))
    );
    assert.strictEqual(badType.status, 400);

    const emptyId = await POST(
      authedPost(JSON.stringify({ payoutId: "   " }))
    );
    assert.strictEqual(emptyId.status, 400);
    assert.strictEqual(syncCalls.length, 0);
  });

  it("propagates the 409 when another sync already holds the lease", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/sync/route"
    );
    syncError = Object.assign(
      new Error("A payout sync is already running — try again shortly."),
      { clientSafe: true, status: 409 }
    );
    const res = await POST(authedPost(JSON.stringify({})));
    assert.strictEqual(res.status, 409);
    const body = await res.json();
    assert.strictEqual(body.ok, false);
  });

  it("propagates a Stripe outage as a safe 502", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/sync/route"
    );
    syncError = Object.assign(
      new Error("Stripe payout list failed — try again shortly."),
      { clientSafe: true, status: 502 }
    );
    const res = await POST(authedPost(JSON.stringify({})));
    assert.strictEqual(res.status, 502);
  });

  it("answers a safe 500 for unexpected failures — no internals leak", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/payouts/sync/route"
    );
    syncError = new Error("firestore: index missing at …");
    const res = await POST(authedPost(JSON.stringify({})));
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.strictEqual(body.error, "The payout sync could not run.");
  });
});
