import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { refreshAdminAccess } from "@/lib/admin-session-refresh";
import type { AdminAccessCheckResult } from "@/lib/admin-session-refresh";

const noDelay = () => Promise.resolve();

function deps(overrides: {
  tokens?: string[];
  checks?: Array<AdminAccessCheckResult | Error>;
  onRefresh?: () => void;
  onCheck?: (checkIndex: number) => void;
  isInitiatorCurrent?: () => boolean;
}) {
  const refreshCalls: string[] = [];
  const checkCalls: string[] = [];
  let refreshIndex = 0;
  let checkIndex = 0;

  return {
    refreshCalls,
    checkCalls,
    deps: {
      forceRefreshIdToken: async () => {
        overrides.onRefresh?.();
        const token = overrides.tokens?.[refreshIndex] ?? "token";
        refreshIndex++;
        refreshCalls.push(token);
        return token;
      },
      checkAdminAccess: async (idToken: string) => {
        const index = checkIndex;
        checkCalls.push(idToken);
        const result =
          overrides.checks?.[index] ??
          overrides.checks?.[overrides.checks.length - 1] ?? {
            isAdmin: false,
          };
        checkIndex++;
        overrides.onCheck?.(index);
        if (result instanceof Error) throw result;
        return result;
      },
      isInitiatorCurrent: overrides.isInitiatorCurrent,
      delay: noDelay,
    },
  };
}

describe("refreshAdminAccess (Issue #94)", () => {
  it("returns the server-confirmed role after a successful refresh", async () => {
    const { deps: d, checkCalls } = deps({
      tokens: ["fresh-token"],
      checks: [{ isAdmin: true, role: "admin" }],
    });
    assert.equal(await refreshAdminAccess(d), "admin");
    // The canonical re-check must run against the refreshed token, never a
    // stale pre-grant credential.
    assert.deepEqual(checkCalls, ["fresh-token"]);
  });

  it("accepts the superadmin role", async () => {
    const { deps: d } = deps({
      checks: [{ isAdmin: true, role: "superadmin" }],
    });
    assert.equal(await refreshAdminAccess(d), "superadmin");
  });

  it("retries when the first refresh still carries stale claims", async () => {
    // Claim propagation edge: first forced refresh still lacks the admin
    // claim, a later one succeeds. Bounded retry covers this without a
    // sign-out round-trip.
    const { deps: d } = deps({
      tokens: ["stale-token", "fresh-token"],
      checks: [{ isAdmin: false }, { isAdmin: true, role: "admin" }],
    });
    assert.equal(await refreshAdminAccess(d), "admin");
  });

  it("returns null — never authorizes — when claims never arrive", async () => {
    const { deps: d, refreshCalls, checkCalls } = deps({
      checks: [{ isAdmin: false }],
    });
    assert.equal(await refreshAdminAccess(d), null);
    // The retry is bounded: no unbounded loop.
    assert.equal(refreshCalls.length, 3);
    assert.equal(checkCalls.length, 3);
  });

  it("returns null when the authorization check keeps failing", async () => {
    const { deps: d, refreshCalls } = deps({
      checks: [new Error("network")],
    });
    assert.equal(await refreshAdminAccess(d), null);
    assert.equal(refreshCalls.length, 3);
  });

  it("returns null when the token refresh itself fails", async () => {
    const { deps: d } = deps({
      checks: [{ isAdmin: true, role: "admin" }],
      onRefresh: () => {
        throw new Error("refresh failed");
      },
    });
    assert.equal(await refreshAdminAccess(d), null);
  });

  it("does not authorize on isAdmin without a valid role", async () => {
    const { deps: d } = deps({
      checks: [{ isAdmin: true }],
    });
    assert.equal(await refreshAdminAccess(d), null);
  });

  it("does not authorize on an unexpected role value", async () => {
    const { deps: d } = deps({
      checks: [{ isAdmin: true, role: "owner" as never }],
    });
    assert.equal(await refreshAdminAccess(d), null);
  });
});

describe("identity binding (account-switch race)", () => {
  it("discards a confirmed role when the initiator signs out while the check is in flight", async () => {
    // User A starts the post-grant refresh; the server confirms admin — but
    // Firebase auth changed to no user before the result could be applied.
    let initiatorCurrent = true;
    const { deps: d, refreshCalls } = deps({
      tokens: ["fresh-token"],
      checks: [{ isAdmin: true, role: "admin" }],
      onCheck: () => {
        initiatorCurrent = false;
      },
      isInitiatorCurrent: () => initiatorCurrent,
    });
    assert.equal(await refreshAdminAccess(d), null);
    // A stale identity must not keep retrying — the result can never apply.
    assert.equal(refreshCalls.length, 1);
  });

  it("discards a confirmed role when the account switched to another user mid-check", async () => {
    // Same race, sign-out → different account: currentUser.uid no longer
    // matches the initiating uid.
    let currentUid = "user-a";
    const { deps: d } = deps({
      checks: [{ isAdmin: true, role: "superadmin" }],
      onCheck: () => {
        currentUid = "user-b";
      },
      isInitiatorCurrent: () => currentUid === "user-a",
    });
    assert.equal(await refreshAdminAccess(d), null);
  });

  it("aborts the bounded retry when the identity changes between attempts", async () => {
    let initiatorCurrent = true;
    const { deps: d, checkCalls } = deps({
      tokens: ["stale-token", "fresh-token"],
      checks: [{ isAdmin: false }, { isAdmin: true, role: "admin" }],
      onCheck: (index) => {
        if (index === 0) initiatorCurrent = false;
      },
      isInitiatorCurrent: () => initiatorCurrent,
    });
    assert.equal(await refreshAdminAccess(d), null);
    // The second attempt never reached the server check — the loop exited on
    // the stale-identity guard before refreshing again.
    assert.equal(checkCalls.length, 1);
  });

  it("still authorizes normally when the initiator remains the current user", async () => {
    const { deps: d } = deps({
      checks: [{ isAdmin: true, role: "admin" }],
      isInitiatorCurrent: () => true,
    });
    assert.equal(await refreshAdminAccess(d), "admin");
  });
});

// The dashboard component is client React that node:test cannot render — the
// repo's established pattern (tests/lib/sentry-config.test.ts) asserts the
// wiring on the source instead. These guards keep the post-grant refresh on
// the canonical path.
describe("post-grant refresh wiring", () => {
  const read = (file: string) =>
    readFileSync(join(process.cwd(), file), "utf8");
  const dashboard = read("components/admin-dashboard.tsx");

  it("accept/bootstrap success re-checks via /api/admin/me with the refreshed token", () => {
    assert.ok(dashboard.includes("refreshAdminAccess"));
    assert.ok(dashboard.includes('"/api/admin/me"'));
    assert.ok(dashboard.includes("getIdToken(true)"));
  });

  it("binds the refresh to the initiating identity before setRole", () => {
    assert.ok(dashboard.includes("isInitiatorCurrent"));
    assert.ok(dashboard.includes("currentUser?.uid"));
    // The identity guard must gate the authorization transition itself.
    assert.ok(
      dashboard.includes(
        "if (!confirmedRole || !isInitiatorCurrent()) return false;"
      )
    );
  });

  it("no longer instructs a successful grant to sign out and back in", () => {
    for (const file of [
      "components/admin-dashboard.tsx",
      "app/api/admin/invitations/accept/route.ts",
      "app/api/admin/bootstrap/route.ts",
    ]) {
      assert.ok(
        !read(file).includes("sign back in to refresh your session"),
        `${file} still instructs a manual sign-out cycle`
      );
      assert.ok(
        !read(file).includes("sign back in to continue"),
        `${file} still instructs a manual sign-out cycle`
      );
    }
  });
});
