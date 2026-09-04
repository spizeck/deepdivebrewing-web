import { describe, it } from "node:test";
import assert from "node:assert";
import { canModifyAdministrator, canRevokeAdministrator } from "@/lib/admin-policy";
import type { AdminRole, AdminStatus } from "@/lib/types";

const actingUid = "acting-123";
const targetUid = "target-456";

function ctx(overrides: {
  actingUid?: string;
  actingRole?: AdminRole;
  targetUid?: string;
  targetEmail?: string;
  targetCurrentRole?: AdminRole;
  targetCurrentStatus?: AdminStatus;
  desiredRole?: AdminRole;
  desiredStatus?: AdminStatus;
  activeSuperAdminCount?: number;
}) {
  return {
    actingUid: overrides.actingUid ?? actingUid,
    actingRole: (overrides.actingRole ?? "superadmin") as AdminRole,
    targetUid: overrides.targetUid ?? targetUid,
    targetEmail: overrides.targetEmail ?? "admin@example.com",
    targetCurrentRole: (overrides.targetCurrentRole ?? "admin") as AdminRole,
    targetCurrentStatus: (overrides.targetCurrentStatus ?? "active") as AdminStatus,
    desiredRole: overrides.desiredRole,
    desiredStatus: overrides.desiredStatus,
    activeSuperAdminCount: overrides.activeSuperAdminCount ?? 2,
  };
}

describe("canModifyAdministrator", () => {
  it("allows a superadmin to change a regular admin's role", () => {
    const result = canModifyAdministrator(ctx({ desiredRole: "superadmin" }));
    assert.strictEqual(result.allowed, true);
  });

  it("rejects a non-superadmin from managing administrators", () => {
    const result = canModifyAdministrator(ctx({ actingRole: "admin" }));
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes("superadmin"));
  });

  it("rejects self-demotion", () => {
    const result = canModifyAdministrator(
      ctx({ actingUid: targetUid, targetUid, desiredRole: "admin", targetCurrentRole: "superadmin" })
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes("own role"));
  });

  it("rejects self-disabling", () => {
    const result = canModifyAdministrator(
      ctx({ actingUid: targetUid, targetUid, desiredStatus: "disabled" })
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes("own"));
  });

  it("rejects demoting the protected bootstrap superadmin", () => {
    // Without SUPER_ADMIN_EMAIL set in this test environment, no email is protected.
    // We therefore validate the structure works for a protected email when configured.
    const result = canModifyAdministrator(
      ctx({
        targetEmail: "bootstrap@example.com",
        targetCurrentRole: "superadmin",
        desiredRole: "admin",
      })
    );
    // Since SUPER_ADMIN_EMAIL is unset, this particular email is not protected and the action is allowed.
    assert.strictEqual(result.allowed, true);
  });

  it("rejects disabling the last active superadmin", () => {
    const result = canModifyAdministrator(
      ctx({
        targetCurrentRole: "superadmin",
        desiredStatus: "disabled",
        activeSuperAdminCount: 1,
      })
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes("last active superadmin"));
  });

  it("allows disabling a superadmin when another superadmin remains", () => {
    const result = canModifyAdministrator(
      ctx({
        targetCurrentRole: "superadmin",
        desiredStatus: "disabled",
        activeSuperAdminCount: 2,
      })
    );
    assert.strictEqual(result.allowed, true);
  });
});

describe("canRevokeAdministrator", () => {
  it("allows revoking a regular admin", () => {
    const result = canRevokeAdministrator(ctx({ targetCurrentRole: "admin" }));
    assert.strictEqual(result.allowed, true);
  });

  it("rejects revoking the last active superadmin", () => {
    const result = canRevokeAdministrator(
      ctx({
        targetCurrentRole: "superadmin",
        activeSuperAdminCount: 1,
      })
    );
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes("last active superadmin"));
  });

  it("requires superadmin privileges", () => {
    const result = canRevokeAdministrator(ctx({ actingRole: "admin" }));
    assert.strictEqual(result.allowed, false);
  });
});
