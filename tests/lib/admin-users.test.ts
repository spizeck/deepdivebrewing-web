import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildDisplayName,
  buildExistingAdminLoginUpdate,
  buildNewAdminUserRecord,
} from "@/lib/admin-users-common";
import type { AdminUserRecord } from "@/lib/admin-types";

function fakeTimestamp(): FirebaseFirestore.Timestamp {
  return {
    toMillis: () => 0,
    toDate: () => new Date(),
  } as unknown as FirebaseFirestore.Timestamp;
}

function noUndefinedValues(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every(noUndefinedValues);
  return Object.values(value).every(noUndefinedValues);
}

describe("buildNewAdminUserRecord", () => {
  it("includes a nonempty displayName when provided", () => {
    const record = buildNewAdminUserRecord(
      "a@example.com",
      "admin",
      "actor-1",
      fakeTimestamp(),
      "Ada Admin"
    );
    assert.strictEqual(record.displayName, "Ada Admin");
    assert.ok(noUndefinedValues(record));
  });

  it("omits displayName when undefined", () => {
    const record = buildNewAdminUserRecord(
      "a@example.com",
      "admin",
      "actor-1",
      fakeTimestamp(),
      undefined
    );
    assert.strictEqual("displayName" in record, false);
    assert.ok(noUndefinedValues(record));
  });

  it("omits displayName when empty after trimming", () => {
    const record = buildNewAdminUserRecord(
      "a@example.com",
      "admin",
      "actor-1",
      fakeTimestamp(),
      "   "
    );
    assert.strictEqual("displayName" in record, false);
    assert.ok(noUndefinedValues(record));
  });

  it("normalizes the email address", () => {
    const record = buildNewAdminUserRecord(
      "  A@Example.COM  ",
      "superadmin",
      "actor-1",
      fakeTimestamp()
    );
    assert.strictEqual(record.email, "a@example.com");
  });
});

describe("buildExistingAdminLoginUpdate", () => {
  it("preserves an existing nonempty display name when the new token has none", () => {
    const update = buildExistingAdminLoginUpdate(
      { displayName: "Existing Name" } as Partial<AdminUserRecord>,
      "actor-1",
      fakeTimestamp(),
      undefined
    );
    assert.strictEqual("displayName" in update, false);
    assert.ok(noUndefinedValues(update));
  });

  it("fills a missing display name when the new token provides one", () => {
    const update = buildExistingAdminLoginUpdate(
      {},
      "actor-1",
      fakeTimestamp(),
      "New Name"
    );
    assert.strictEqual(update.displayName, "New Name");
    assert.ok(noUndefinedValues(update));
  });

  it("does not overwrite an existing display name with a new one", () => {
    const update = buildExistingAdminLoginUpdate(
      { displayName: "Existing Name" } as Partial<AdminUserRecord>,
      "actor-1",
      fakeTimestamp(),
      "New Name"
    );
    assert.strictEqual("displayName" in update, false);
  });
});

describe("buildDisplayName", () => {
  it("returns an empty object when the name is missing or whitespace", () => {
    assert.deepStrictEqual(buildDisplayName(undefined), {});
    assert.deepStrictEqual(buildDisplayName(""), {});
    assert.deepStrictEqual(buildDisplayName("  "), {});
  });

  it("returns a trimmed display name when provided", () => {
    assert.deepStrictEqual(buildDisplayName("  Ada  "), { displayName: "Ada" });
  });
});
