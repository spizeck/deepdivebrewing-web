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
        checkCalls.push(idToken);
        const result =
          overrides.checks?.[checkIndex] ??
          overrides.checks?.[overrides.checks.length - 1] ?? {
            isAdmin: false,
          };
        checkIndex++;
        if (result instanceof Error) throw result;
        return result;
      },
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
