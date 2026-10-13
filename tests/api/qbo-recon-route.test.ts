import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { NextRequest } from "next/server";

// Route-level coverage for the issue #181 reconciliation endpoint: the
// admin-actor requirement ("accounting" capability), the GET/POST split
// between last-run and fresh-run, and safe error mapping. Server-only
// dependencies are module-mocked; the handlers run against a real
// NextRequest so the auth decisions tested are the route's own.

mock.module("server-only", { namedExports: {} });

let latestRun: Record<string, unknown> | null = { ranAt: "2026-06-01T00:00:00.000Z" };
let runCalls: { from?: string; to?: string }[] = [];
const runResult: Record<string, unknown> = { ranAt: "2026-06-15T00:00:00.000Z" };
let runError: { message: string; status: number; clientSafe?: boolean } | null =
  null;

mock.module("@/lib/qbo-recon", {
  namedExports: {
    getQboReconLatest: async () => latestRun,
    runQboReconciliation: async (input: { from?: string; to?: string }) => {
      runCalls.push({ from: input.from, to: input.to });
      if (runError) {
        throw Object.assign(new Error(runError.message), {
          clientSafe: runError.clientSafe,
          status: runError.status,
        });
      }
      return runResult;
    },
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

function req(
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): NextRequest {
  return new NextRequest(`https://deepdivebrewing.com${path}`, init);
}

const AUTH = { authorization: "Bearer id-token" };

beforeEach(() => {
  latestRun = { ranAt: "2026-06-01T00:00:00.000Z" };
  runCalls = [];
  runError = null;
  adminError = null;
  requestedPermissions.length = 0;
});

describe("GET /api/admin/quickbooks/reconciliation", () => {
  it("rejects unauthenticated calls", async () => {
    const { GET } = await import(
      "@/app/api/admin/quickbooks/reconciliation/route"
    );
    const res = await GET(req("/api/admin/quickbooks/reconciliation"));
    assert.strictEqual(res.status, 401);
  });

  it("requires the accounting capability and returns the last run", async () => {
    const { GET } = await import(
      "@/app/api/admin/quickbooks/reconciliation/route"
    );
    const res = await GET(
      req("/api/admin/quickbooks/reconciliation", { headers: AUTH })
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.run.ranAt, "2026-06-01T00:00:00.000Z");
    assert.deepStrictEqual(requestedPermissions, ["accounting"]);
  });

  it("propagates an authorization failure without touching the report", async () => {
    const { GET } = await import(
      "@/app/api/admin/quickbooks/reconciliation/route"
    );
    adminError = { message: "Forbidden.", status: 403 };
    const res = await GET(
      req("/api/admin/quickbooks/reconciliation", { headers: AUTH })
    );
    assert.strictEqual(res.status, 403);
  });
});

describe("POST /api/admin/quickbooks/reconciliation", () => {
  it("rejects unauthenticated calls and runs nothing", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/reconciliation/route"
    );
    const res = await POST(
      req("/api/admin/quickbooks/reconciliation", { method: "POST" })
    );
    assert.strictEqual(res.status, 401);
    assert.strictEqual(runCalls.length, 0);
  });

  it("runs a default-range report on an empty body", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/reconciliation/route"
    );
    const res = await POST(
      req("/api/admin/quickbooks/reconciliation", {
        method: "POST",
        headers: AUTH,
      })
    );
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.run.ranAt, "2026-06-15T00:00:00.000Z");
    assert.deepStrictEqual(runCalls, [{ from: undefined, to: undefined }]);
  });

  it("forwards an explicit from/to window", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/reconciliation/route"
    );
    const res = await POST(
      req("/api/admin/quickbooks/reconciliation", {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ from: "2026-05-01", to: "2026-05-31" }),
      })
    );
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(runCalls, [
      { from: "2026-05-01", to: "2026-05-31" },
    ]);
  });

  it("surfaces a client-safe validation error as its status", async () => {
    const { POST } = await import(
      "@/app/api/admin/quickbooks/reconciliation/route"
    );
    runError = {
      message: "Reconciliation dates must be valid YYYY-MM-DD calendar days.",
      status: 400,
      clientSafe: true,
    };
    const res = await POST(
      req("/api/admin/quickbooks/reconciliation", {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({ from: "bad", to: "2026-05-31" }),
      })
    );
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.ok, false);
    assert.ok(body.error.includes("YYYY-MM-DD"));
  });
});
