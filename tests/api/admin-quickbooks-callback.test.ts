// Route-level unit test for the QuickBooks OAuth callback
// (app/api/admin/quickbooks/callback/route.ts). The trust boundary is the
// one-time OAuth state plus a re-check that the initiating admin still has
// an active adminUsers record — an admin disabled between connect and
// callback must not complete the connection. The server-only dependencies
// (@/lib/qbo, @/lib/admin-users, @/lib/log) are module-mocked so the test
// drives the handler directly with a real NextRequest and inspects the
// redirect it returns.
import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { NextRequest, type NextResponse } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { QBO_OAUTH_COOKIE } from "@/lib/qbo-callback-cookie";
import type { AdminUserRecord } from "@/lib/admin-types";
import type { QboStateConsumption } from "@/lib/qbo";

interface CompleteCall {
  code: string;
  realmId: string;
  uid: string;
  email?: string;
}

interface LogLine {
  level: "info" | "warn" | "error";
  event: string;
  context?: Record<string, unknown>;
}

let consumeResult: QboStateConsumption = { verdict: "missing" };
let adminRecord: AdminUserRecord | null = null;
let consumeCalls = 0;
const completed: CompleteCall[] = [];
const logs: LogLine[] = [];

mock.module("server-only", { namedExports: {} });
mock.module("@/lib/qbo", {
  namedExports: {
    consumeQboOAuthState: () => {
      consumeCalls += 1;
      return Promise.resolve(consumeResult);
    },
    completeQboAuthorization: (input: CompleteCall) => {
      completed.push(input);
      return Promise.resolve({ companyName: "Deep Dive Brewing Sandbox" });
    },
  },
});
mock.module("@/lib/admin-users", {
  namedExports: {
    getAdminUser: () => Promise.resolve(adminRecord),
  },
});
mock.module("@/lib/log", {
  namedExports: {
    getRequestId: () => "req-test",
    logInfo: (event: string, context?: Record<string, unknown>) =>
      logs.push({ level: "info", event, context }),
    logWarn: (event: string, context?: Record<string, unknown>) =>
      logs.push({ level: "warn", event, context }),
    logError: (
      event: string,
      _error?: unknown,
      context?: Record<string, unknown>
    ) => logs.push({ level: "error", event, context }),
  },
});

const CALLBACK_URL =
  "https://app.example.com/api/admin/quickbooks/callback";

function callbackRequest(
  params: Record<string, string>,
  cookieState?: string
): NextRequest {
  const url = new URL(CALLBACK_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const req = new NextRequest(url);
  if (cookieState !== undefined) {
    req.cookies.set(QBO_OAUTH_COOKIE, cookieState);
  }
  return req;
}

function adminUser(
  overrides: Partial<AdminUserRecord> = {}
): AdminUserRecord {
  return {
    uid: "uid-1",
    email: "admin@example.com",
    role: "admin",
    status: "active",
    // The default initiator holds the accounting capability (issue #210);
    // a plain admin-role record without it must not complete the flow.
    permissions: ["accounting"],
    createdAt: Timestamp.now(),
    ...overrides,
  };
}

function validParams(): Record<string, string> {
  return { code: "authcode-1", state: "state-1", realmId: "realm-1" };
}

async function callRoute(req: NextRequest): Promise<NextResponse> {
  const { GET } = await import("@/app/api/admin/quickbooks/callback/route");
  return GET(req);
}

function redirectParams(res: NextResponse): URLSearchParams {
  const location = res.headers.get("location");
  assert.ok(location, "expected a redirect response");
  const url = new URL(location);
  assert.strictEqual(url.pathname, "/admin/integrations/quickbooks");
  return url.searchParams;
}

beforeEach(() => {
  consumeResult = { verdict: "ok", uid: "uid-1", email: "admin@example.com" };
  adminRecord = adminUser();
  consumeCalls = 0;
  completed.length = 0;
  logs.length = 0;
});

describe("quickbooks oauth callback", () => {
  it("completes the connection for a still-active initiating admin", async () => {
    const res = await callRoute(callbackRequest(validParams(), "state-1"));
    assert.strictEqual(redirectParams(res).get("qbo"), "connected");
    assert.deepStrictEqual(completed, [
      {
        code: "authcode-1",
        realmId: "realm-1",
        uid: "uid-1",
        email: "admin@example.com",
      },
    ]);
    // The httpOnly state cookie is always cleared on the way out.
    assert.match(res.headers.get("set-cookie") ?? "", /qbo_oauth_state=/);
  });

  it("still permits an active initiator under the other admin role", async () => {
    // Either admin role may run this flow — a role change between connect
    // and callback does not block completion while the record stays active.
    adminRecord = adminUser({ role: "superadmin" });
    const res = await callRoute(callbackRequest(validParams(), "state-1"));
    assert.strictEqual(redirectParams(res).get("qbo"), "connected");
    assert.strictEqual(completed.length, 1);
  });

  it("refuses before provider exchange when the initiator record is gone", async () => {
    adminRecord = null;
    const res = await callRoute(callbackRequest(validParams(), "state-1"));
    const params = redirectParams(res);
    assert.strictEqual(params.get("qbo"), "error");
    assert.strictEqual(params.get("qbo_reason"), "connect_failed");
    assert.strictEqual(completed.length, 0);
    assert.ok(
      logs.some(
        (line) =>
          line.event === "qbo.oauth.failed" &&
          line.context?.reason === "initiating_admin_inactive"
      ),
      "expected the initiating_admin_inactive failure to be logged"
    );
    // The redirect carries the coarse outcome only — no admin details.
    const location = res.headers.get("location") ?? "";
    assert.ok(!location.includes("uid-1"));
    assert.ok(!location.includes("admin%40example.com"));
    assert.deepStrictEqual([...params.keys()].sort(), [
      "qbo",
      "qbo_reason",
    ]);
  });

  it("refuses when the initiator lost the accounting permission mid-flow", async () => {
    // A still-active admin whose "accounting" grant was revoked between
    // connect and callback must not complete the connection (issue #210).
    adminRecord = adminUser({ permissions: [] });
    const res = await callRoute(callbackRequest(validParams(), "state-1"));
    assert.strictEqual(
      redirectParams(res).get("qbo_reason"),
      "connect_failed"
    );
    assert.strictEqual(completed.length, 0);
    assert.ok(
      logs.some(
        (line) =>
          line.event === "qbo.oauth.failed" &&
          line.context?.reason === "initiating_admin_inactive"
      )
    );
  });

  it("refuses when the initiator was disabled mid-flow", async () => {
    adminRecord = adminUser({ status: "disabled" });
    const res = await callRoute(callbackRequest(validParams(), "state-1"));
    assert.strictEqual(
      redirectParams(res).get("qbo_reason"),
      "connect_failed"
    );
    assert.strictEqual(completed.length, 0);
  });

  it("rejects when the cookie state does not match the callback state", async () => {
    const res = await callRoute(
      callbackRequest(validParams(), "other-state")
    );
    assert.strictEqual(
      redirectParams(res).get("qbo_reason"),
      "state_invalid"
    );
    assert.strictEqual(consumeCalls, 0);
    assert.strictEqual(completed.length, 0);
  });

  it("rejects callbacks missing required parameters", async () => {
    const res = await callRoute(
      callbackRequest({ state: "state-1" }, "state-1")
    );
    assert.strictEqual(
      redirectParams(res).get("qbo_reason"),
      "invalid_callback"
    );
    assert.strictEqual(consumeCalls, 0);
  });

  it("maps non-ok state verdicts to coarse redirect reasons", async () => {
    const cases: Array<[QboStateConsumption, string]> = [
      [{ verdict: "missing" }, "state_invalid"],
      [{ verdict: "expired" }, "state_expired"],
      [{ verdict: "consumed" }, "state_replayed"],
      [{ verdict: "environment_mismatch" }, "state_invalid"],
    ];
    for (const [consumption, reason] of cases) {
      consumeResult = consumption;
      const res = await callRoute(callbackRequest(validParams(), "state-1"));
      assert.strictEqual(
        redirectParams(res).get("qbo_reason"),
        reason,
        `verdict ${consumption.verdict}`
      );
    }
    assert.strictEqual(completed.length, 0);
  });

  it("reports a declined provider consent without touching state", async () => {
    const res = await callRoute(
      callbackRequest({ error: "access_denied" }, "state-1")
    );
    assert.strictEqual(redirectParams(res).get("qbo_reason"), "denied");
    assert.strictEqual(consumeCalls, 0);
    assert.strictEqual(completed.length, 0);
  });
});
