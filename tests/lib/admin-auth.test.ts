import { describe, it } from "node:test";
import assert from "node:assert";
import {
  getAdminClaims,
  isAdmin,
  isSuperAdmin,
  normalizeEmail,
} from "@/lib/admin-common";
import type { DecodedIdToken } from "firebase-admin/auth";

function token(claims: Partial<DecodedIdToken>): DecodedIdToken {
  return {
    aud: "",
    auth_time: 0,
    exp: 0,
    firebase: { identities: {}, sign_in_provider: "google.com" },
    iat: 0,
    iss: "",
    sub: "",
    uid: "uid-123",
    ...claims,
  } as DecodedIdToken;
}

describe("normalizeEmail", () => {
  it("trims and lowercases emails", () => {
    assert.strictEqual(normalizeEmail("  Test@Example.COM  "), "test@example.com");
  });

  it("handles null and undefined", () => {
    assert.strictEqual(normalizeEmail(null), "");
    assert.strictEqual(normalizeEmail(undefined), "");
  });
});

describe("getAdminClaims", () => {
  it("returns null when no claims are present", () => {
    assert.strictEqual(getAdminClaims(token({})), null);
  });

  it("returns null for an unrecognized role", () => {
    assert.strictEqual(
      getAdminClaims(token({ admin: true, role: "owner" }) as DecodedIdToken),
      null
    );
  });

  it("returns admin claim for admin role", () => {
    const claims = getAdminClaims(token({ admin: true, role: "admin" }) as DecodedIdToken);
    assert.deepStrictEqual(claims, { admin: true, role: "admin" });
  });

  it("returns superadmin claim for superadmin role", () => {
    const claims = getAdminClaims(
      token({ admin: true, role: "superadmin" }) as DecodedIdToken
    );
    assert.deepStrictEqual(claims, { admin: true, role: "superadmin" });
  });
});

describe("isAdmin and isSuperAdmin", () => {
  it("detects admin role", () => {
    const t = token({ admin: true, role: "admin" }) as DecodedIdToken;
    assert.strictEqual(isAdmin(t), true);
    assert.strictEqual(isSuperAdmin(t), false);
  });

  it("detects superadmin role", () => {
    const t = token({ admin: true, role: "superadmin" }) as DecodedIdToken;
    assert.strictEqual(isAdmin(t), true);
    assert.strictEqual(isSuperAdmin(t), true);
  });

  it("rejects missing admin flag", () => {
    const t = token({ role: "superadmin" }) as DecodedIdToken;
    assert.strictEqual(isAdmin(t), false);
    assert.strictEqual(isSuperAdmin(t), false);
  });
});
