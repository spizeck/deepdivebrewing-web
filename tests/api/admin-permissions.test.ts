import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AdminUserRecord } from "@/lib/admin-types";
import { ADMIN_PERMISSIONS } from "@/lib/admin-permissions";

// Capability-permission coverage (issue #210):
// - PATCH /api/admin/users/[uid] grants/revokes permissions server-side with
//   fail-closed validation and audit fields.
// - GET /api/admin/me exposes the effective permission set from the live
//   adminUsers record (superadmin => all).
// - A source scan asserts every QBO/payments admin route authorizes through
//   requireAdminPermission — no endpoint may rely on UI hiding alone.

mock.module("server-only", { namedExports: {} });

let adminError: { message: string; status: number } | null = null;
let decodedToken: Record<string, unknown> = {
  uid: "actor-1",
  email: "boss@example.test",
  email_verified: true,
  admin: true,
  role: "superadmin",
};

mock.module("@/lib/admin-auth", {
  namedExports: {
    normalizeEmail: (email: string | null | undefined) =>
      (email ?? "").trim().toLowerCase(),
    isProtectedAdmin: () => false,
    requireSuperAdminActor: async () => {
      if (adminError) {
        throw Object.assign(new Error(adminError.message), {
          clientSafe: true,
          status: adminError.status,
        });
      }
      return {
        token: { uid: "actor-1", email: "boss@example.test" },
        claims: { admin: true, role: "superadmin" },
        record: { uid: "actor-1", email: "boss@example.test" },
      };
    },
    verifyAdminIdToken: async () => decodedToken,
    getAdminClaims: (token: Record<string, unknown>) =>
      token.admin === true &&
      (token.role === "superadmin" || token.role === "admin")
        ? { admin: true as const, role: token.role }
        : null,
  },
});

let targetRecord: AdminUserRecord | null = null;
const updateCalls: Array<Record<string, unknown>> = [];

mock.module("@/lib/admin-users", {
  namedExports: {
    getAdminUser: async () => targetRecord,
    updateAdminUser: async (
      _uid: string,
      updates: Record<string, unknown>
    ) => {
      updateCalls.push(updates);
    },
    countActiveSuperAdmins: async () => 2,
  },
});

const auditCalls: Array<Record<string, unknown>> = [];

mock.module("@/lib/admin-audit", {
  namedExports: {
    logAdminAudit: async (record: Record<string, unknown>) => {
      auditCalls.push(record);
    },
  },
});

const claimCalls: Array<unknown> = [];

mock.module("@/lib/firebase-admin-auth", {
  namedExports: {
    getFirebaseAdminAuth: () => ({
      setCustomUserClaims: async (_uid: string, claims: unknown) => {
        claimCalls.push(claims);
      },
    }),
  },
});

mock.module("@/lib/admin-invitations", {
  namedExports: {
    getPendingInvitationByEmail: async () => null,
  },
});

function adminRecord(
  overrides: Partial<AdminUserRecord> = {}
): AdminUserRecord {
  return {
    uid: "target-1",
    email: "staff@example.test",
    role: "admin",
    status: "active",
    permissions: ["payments"],
    createdAt: { toDate: () => new Date() } as AdminUserRecord["createdAt"],
    ...overrides,
  };
}

function patchReq(uid: string, body: unknown) {
  const req = new NextRequest(
    `https://deepdivebrewing.com/api/admin/users/${uid}`,
    {
      method: "PATCH",
      headers: {
        Authorization: "Bearer id-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  return { req, params: Promise.resolve({ uid }) };
}

beforeEach(() => {
  adminError = null;
  targetRecord = adminRecord();
  updateCalls.length = 0;
  auditCalls.length = 0;
  claimCalls.length = 0;
  decodedToken = {
    uid: "actor-1",
    email: "boss@example.test",
    email_verified: true,
    admin: true,
    role: "superadmin",
  };
});

describe("PATCH /api/admin/users/[uid] — permission management (#210)", () => {
  it("a superadmin can grant a permission", async () => {
    const { PATCH } = await import("@/app/api/admin/users/[uid]/route");
    const { req, params } = patchReq("target-1", {
      permissions: ["payments", "accounting"],
    });
    const res = await PATCH(req, { params });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(updateCalls, [
      { permissions: ["payments", "accounting"] },
    ]);
    assert.strictEqual(auditCalls.length, 1);
    assert.deepStrictEqual(auditCalls[0].oldPermissions, ["payments"]);
    assert.deepStrictEqual(auditCalls[0].newPermissions, [
      "payments",
      "accounting",
    ]);
  });

  it("a superadmin can revoke permissions (empty set)", async () => {
    const { PATCH } = await import("@/app/api/admin/users/[uid]/route");
    const { req, params } = patchReq("target-1", { permissions: [] });
    const res = await PATCH(req, { params });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(updateCalls, [{ permissions: [] }]);
    assert.deepStrictEqual(auditCalls[0].newPermissions, []);
  });

  it("rejects unknown permission keys — fail closed", async () => {
    const { PATCH } = await import("@/app/api/admin/users/[uid]/route");
    for (const body of [
      { permissions: ["accounting", "everything"] },
      { permissions: "accounting" },
      { permissions: { accounting: true } },
      { permissions: ["superadmin"] },
    ]) {
      const { req, params } = patchReq("target-1", body);
      const res = await PATCH(req, { params });
      assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.strictEqual(updateCalls.length, 0);
    assert.strictEqual(auditCalls.length, 0);
  });

  it("an ordinary admin cannot grant permissions at all", async () => {
    adminError = {
      message: "This action requires superadmin access.",
      status: 403,
    };
    const { PATCH } = await import("@/app/api/admin/users/[uid]/route");
    const { req, params } = patchReq("target-1", {
      permissions: ["accounting", "payments"],
    });
    const res = await PATCH(req, { params });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(updateCalls.length, 0);
  });

  it("permission changes never touch custom claims", async () => {
    // Permissions live only on the adminUsers record, so a grant/revoke
    // takes effect on the next request with no token refresh — the route
    // must not sync claims for a permissions-only update.
    const { PATCH } = await import("@/app/api/admin/users/[uid]/route");
    const { req, params } = patchReq("target-1", {
      permissions: ["accounting"],
    });
    const res = await PATCH(req, { params });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(claimCalls.length, 0);
  });
});

describe("GET /api/admin/me — effective permissions (#210)", () => {
  function meReq() {
    return new NextRequest("https://deepdivebrewing.com/api/admin/me", {
      headers: { Authorization: "Bearer id-token" },
    });
  }

  it("returns the stored permission set for an ordinary admin", async () => {
    // The real checkAdminActorRecord runs here, so the token's role must
    // agree with the record's.
    decodedToken = { ...decodedToken, role: "admin" };
    const { GET } = await import("@/app/api/admin/me/route");
    const res = await GET(meReq());
    assert.strictEqual(res.status, 200);
    const body = (await res.json()) as { permissions?: string[] };
    assert.deepStrictEqual(body.permissions, ["payments"]);
  });

  it("returns every permission for a superadmin record", async () => {
    targetRecord = adminRecord({ role: "superadmin", permissions: [] });
    const { GET } = await import("@/app/api/admin/me/route");
    const res = await GET(meReq());
    const body = (await res.json()) as { permissions?: string[] };
    assert.deepStrictEqual(body.permissions, [...ADMIN_PERMISSIONS]);
  });

  it("returns an empty set for an admin record without permissions", async () => {
    decodedToken = { ...decodedToken, role: "admin" };
    targetRecord = adminRecord({ permissions: undefined });
    const { GET } = await import("@/app/api/admin/me/route");
    const res = await GET(meReq());
    const body = (await res.json()) as { permissions?: string[] };
    assert.deepStrictEqual(body.permissions, []);
  });
});

describe("capability route wiring — no UI-only authorization (#210)", () => {
  const read = (rel: string) =>
    readFileSync(join(process.cwd(), rel), "utf8");

  function adminRoutesUnder(dir: string): string[] {
    const base = join(process.cwd(), dir);
    const out: string[] = [];
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...adminRoutesUnder(rel));
      else if (entry.name === "route.ts") out.push(rel);
    }
    return out;
  }

  it("every admin QuickBooks route requires the accounting capability", () => {
    const routes = adminRoutesUnder("app/api/admin/quickbooks").filter(
      // The OAuth callback is a browser redirect target — its trust boundary
      // is the consumed state plus an initiator permission re-check.
      (rel) => !rel.endsWith(join("callback", "route.ts"))
    );
    assert.ok(routes.length >= 7, "expected all QBO admin routes");
    for (const rel of routes) {
      const source = read(rel);
      assert.ok(
        source.includes('requireAdminPermission(idToken, "accounting")'),
        `${rel} must enforce the accounting permission`
      );
    }
  });

  it("the OAuth callback re-checks the initiator's accounting permission", () => {
    const source = read("app/api/admin/quickbooks/callback/route.ts");
    assert.ok(source.includes('recordHasPermission(initiator, "accounting")'));
  });

  it("every admin payments route requires the payments capability", () => {
    const routes = adminRoutesUnder("app/api/admin/payments");
    assert.ok(routes.length >= 5, "expected all payments admin routes");
    for (const rel of routes) {
      const source = read(rel);
      assert.ok(
        source.includes('requireAdminPermission(idToken, "payments")'),
        `${rel} must enforce the payments permission`
      );
    }
  });
});
