import { describe, it } from "node:test";
import assert from "node:assert";
import {
  ADMIN_PERMISSIONS,
  isAdminPermission,
  normalizeAdminPermissions,
  recordHasPermission,
  recordPermissions,
} from "@/lib/admin-permissions";

// The capability model (issue #210): permissions live on the adminUsers
// record, superadmins hold all of them implicitly, and anything unknown fails
// closed.

describe("isAdminPermission", () => {
  it("accepts every declared permission", () => {
    for (const permission of ADMIN_PERMISSIONS) {
      assert.strictEqual(isAdminPermission(permission), true);
    }
  });

  it("rejects unknown, non-string, and role names", () => {
    for (const value of [
      "accountig",
      "admin",
      "superadmin",
      "role",
      "",
      1,
      null,
      undefined,
      {},
      [],
    ]) {
      assert.strictEqual(isAdminPermission(value), false, String(value));
    }
  });
});

describe("normalizeAdminPermissions", () => {
  it("accepts a list of known permissions", () => {
    assert.deepStrictEqual(normalizeAdminPermissions(["accounting"]), [
      "accounting",
    ]);
    assert.deepStrictEqual(
      normalizeAdminPermissions(["payments", "accounting"]),
      ["payments", "accounting"]
    );
  });

  it("accepts an empty list (revoke-all)", () => {
    assert.deepStrictEqual(normalizeAdminPermissions([]), []);
  });

  it("deduplicates entries", () => {
    assert.deepStrictEqual(
      normalizeAdminPermissions(["payments", "payments", "accounting"]),
      ["payments", "accounting"]
    );
  });

  it("fails closed on any unknown entry", () => {
    assert.strictEqual(
      normalizeAdminPermissions(["payments", "everything"]),
      null
    );
  });

  it("fails closed on non-array input", () => {
    for (const value of [
      "accounting",
      { permissions: ["payments"] },
      42,
      null,
      undefined,
      true,
    ]) {
      assert.strictEqual(normalizeAdminPermissions(value), null, String(value));
    }
  });
});

describe("recordPermissions / recordHasPermission", () => {
  it("grants a superadmin every permission implicitly", () => {
    const record = { role: "superadmin" };
    assert.deepStrictEqual(
      recordPermissions(record),
      [...ADMIN_PERMISSIONS]
    );
    for (const permission of ADMIN_PERMISSIONS) {
      assert.strictEqual(recordHasPermission(record, permission), true);
    }
  });

  it("gives an ordinary admin only the stored grants", () => {
    const record = { role: "admin", permissions: ["payments"] };
    assert.deepStrictEqual(recordPermissions(record), ["payments"]);
    assert.strictEqual(recordHasPermission(record, "payments"), true);
    assert.strictEqual(recordHasPermission(record, "accounting"), false);
  });

  it("a payments-only admin cannot reach accounting", () => {
    // The rollout requirement: payment-taking must never imply QBO access.
    const record = { role: "admin", permissions: ["payments"] };
    assert.strictEqual(recordHasPermission(record, "accounting"), false);
  });

  it("gives an admin with no permissions field nothing", () => {
    // Legacy records predate the field — absence means least privilege.
    const record = { role: "admin" };
    assert.deepStrictEqual(recordPermissions(record), []);
    assert.strictEqual(recordHasPermission(record, "payments"), false);
  });

  it("ignores unknown values stored on the record", () => {
    const record = {
      role: "admin",
      permissions: ["payments", "bogus", 7],
    };
    assert.deepStrictEqual(recordPermissions(record), ["payments"]);
  });

  it("ignores a non-array permissions field", () => {
    const record = { role: "admin", permissions: "payments" };
    assert.deepStrictEqual(recordPermissions(record), []);
  });

  it("denies null/absent records", () => {
    assert.strictEqual(recordHasPermission(null, "accounting"), false);
    assert.strictEqual(recordHasPermission(undefined, "payments"), false);
  });
});
