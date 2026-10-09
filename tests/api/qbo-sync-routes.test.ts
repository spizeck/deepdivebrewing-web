import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { NextRequest } from "next/server";
import { withEnv } from "../lib/qbo-test-helpers";

// Route-level coverage for the issue #183 endpoints: the cron sweep's
// shared-secret gate and the admin sync surface's actor requirement.
// Server-only dependencies are module-mocked; the handlers run against a
// real NextRequest so the auth decisions being tested are the route's own.

mock.module("server-only", { namedExports: {} });

const sweepResult: Record<string, unknown> = {
  environment: "sandbox",
  paused: false,
  paymentsScanned: 0,
  enqueued: 0,
  enqueueErrors: 0,
  processed: 0,
  outcomes: {},
  errors: 0,
};
let sweepCalls = 0;

mock.module("@/lib/qbo-sweep", {
  namedExports: {
    runQboSyncSweep: async () => {
      sweepCalls += 1;
      return sweepResult;
    },
  },
});

const syncView: Record<string, unknown> | null = { paused: false };
const requeueCalls: string[] = [];
const requeueResult: Record<string, unknown> = {
  syncId: "sandbox:stripe_payment:x",
  outcome: "synced",
};

mock.module("@/lib/qbo-sync-admin", {
  namedExports: {
    getQboSyncAdminView: async () => syncView,
    requeueQboSyncRecord: async (_actor: unknown, syncId: string) => {
      requeueCalls.push(syncId);
      return requeueResult;
    },
  },
});

let adminError: { message: string; status: number } | null = null;
const requestedPermissions: string[] = [];

mock.module("@/lib/admin-auth", {
  namedExports: {
    // QBO routes now authorize by the "accounting" capability (issue #210);
    // the mock records the requested permission so the tests can assert it.
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

mock.module("@/lib/admin-audit", {
  namedExports: { logAdminAudit: async () => {} },
});

function req(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): NextRequest {
  return new NextRequest(`https://deepdivebrewing.com${url}`, init);
}

beforeEach(() => {
  sweepCalls = 0;
  requeueCalls.length = 0;
  adminError = null;
  requestedPermissions.length = 0;
});

describe("GET /api/cron/qbo-sweep — cron secret gate (#183)", () => {
  it("rejects requests with no credentials — and fails closed without a secret", async () => {
    const { GET } = await import("@/app/api/cron/qbo-sweep/route");
    await withEnv({ CRON_SECRET: undefined }, async () => {
      const res = await GET(req("/api/cron/qbo-sweep"));
      assert.strictEqual(res.status, 401);
      const withHeader = await GET(
        req("/api/cron/qbo-sweep", {
          headers: { authorization: "Bearer anything" },
        })
      );
      assert.strictEqual(withHeader.status, 401);
    });
    assert.strictEqual(sweepCalls, 0);
  });

  it("rejects a wrong or malformed bearer token", async () => {
    const { GET } = await import("@/app/api/cron/qbo-sweep/route");
    await withEnv({ CRON_SECRET: "test-cron-secret" }, async () => {
      for (const authorization of [
        "Bearer wrong-secret",
        "bearer",
        "test-cron-secret",
        "",
      ]) {
        const res = await GET(
          req("/api/cron/qbo-sweep", { headers: { authorization } })
        );
        assert.strictEqual(res.status, 401, `authorization: ${authorization}`);
      }
    });
    assert.strictEqual(sweepCalls, 0);
  });

  it("runs the sweep for the configured secret and returns the summary", async () => {
    const { GET } = await import("@/app/api/cron/qbo-sweep/route");
    await withEnv({ CRON_SECRET: "test-cron-secret" }, async () => {
      const res = await GET(
        req("/api/cron/qbo-sweep", {
          headers: { authorization: "Bearer test-cron-secret" },
        })
      );
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.ok, true);
      assert.strictEqual(body.environment, "sandbox");
    });
    assert.strictEqual(sweepCalls, 1);
  });
});

describe("admin sync routes — actor requirement (#183)", () => {
  it("GET /api/admin/quickbooks/sync rejects unauthenticated calls", async () => {
    const { GET } = await import("@/app/api/admin/quickbooks/sync/route");
    const res = await GET(req("/api/admin/quickbooks/sync"));
    assert.strictEqual(res.status, 401);
  });

  it("GET /api/admin/quickbooks/sync returns the view for an admin", async () => {
    const { GET } = await import("@/app/api/admin/quickbooks/sync/route");
    const res = await GET(
      req("/api/admin/quickbooks/sync", {
        headers: { authorization: "Bearer id-token" },
      })
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(body.sync, { paused: false });
  });

  it("GET /api/admin/quickbooks/sync requires the accounting capability", async () => {
    const { GET } = await import("@/app/api/admin/quickbooks/sync/route");
    await GET(
      req("/api/admin/quickbooks/sync", {
        headers: { authorization: "Bearer id-token" },
      })
    );
    assert.deepStrictEqual(requestedPermissions, ["accounting"]);
  });

  it("POST sweep requires the accounting capability", async () => {
    const { POST } = await import("@/app/api/admin/quickbooks/sync/route");
    await POST(
      req("/api/admin/quickbooks/sync", {
        method: "POST",
        headers: { authorization: "Bearer id-token" },
      })
    );
    assert.deepStrictEqual(requestedPermissions, ["accounting"]);
    assert.strictEqual(sweepCalls, 1);
  });

  it("GET /api/admin/quickbooks/sync enforces the admin actor check", async () => {
    const { GET } = await import("@/app/api/admin/quickbooks/sync/route");
    adminError = {
      message: "This action requires administrator access.",
      status: 403,
    };
    const res = await GET(
      req("/api/admin/quickbooks/sync", {
        headers: { authorization: "Bearer id-token" },
      })
    );
    assert.strictEqual(res.status, 403);
  });

  it("POST retry rejects unauthenticated calls and validates input", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/sync/retry/route"
    );
    const unauth = await POST(
      req("/api/admin/quickbooks/sync/retry", { method: "POST" })
    );
    assert.strictEqual(unauth.status, 401);

    const missing = await POST(
      req("/api/admin/quickbooks/sync/retry", {
        method: "POST",
        headers: {
          authorization: "Bearer id-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      })
    );
    assert.strictEqual(missing.status, 400);
    assert.strictEqual(requeueCalls.length, 0);
  });

  it("POST retry requeues the record for an admin", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/sync/retry/route"
    );
    const res = await POST(
      req("/api/admin/quickbooks/sync/retry", {
        method: "POST",
        headers: {
          authorization: "Bearer id-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ syncId: "sandbox:stripe_payment:x" }),
      })
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(requeueCalls, ["sandbox:stripe_payment:x"]);
    assert.deepStrictEqual(requestedPermissions, ["accounting"]);
  });

  it("POST retry enforces the admin actor check", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/sync/retry/route"
    );
    adminError = {
      message: "This action requires administrator access.",
      status: 403,
    };
    const res = await POST(
      req("/api/admin/quickbooks/sync/retry", {
        method: "POST",
        headers: {
          authorization: "Bearer id-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ syncId: "sandbox:stripe_payment:x" }),
      })
    );
    assert.strictEqual(res.status, 403);
    assert.strictEqual(requeueCalls.length, 0);
  });
});
