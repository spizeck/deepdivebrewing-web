import { describe, it } from "node:test";
import assert from "node:assert";
import { formatAdminDate, formatAdminDateTime } from "@/lib/admin-format";

describe("formatAdminDate", () => {
  it("formats an ISO date string", () => {
    const value = "2025-01-15T00:00:00.000Z";
    const result = formatAdminDate(value);
    assert.notStrictEqual(result, "Unknown");
    assert.match(result, /2025/);
  });

  it("returns Unknown for undefined", () => {
    assert.strictEqual(formatAdminDate(undefined), "Unknown");
  });

  it("returns Unknown for null", () => {
    assert.strictEqual(formatAdminDate(null), "Unknown");
  });

  it("returns Unknown for an empty string", () => {
    assert.strictEqual(formatAdminDate(""), "Unknown");
  });

  it("returns Unknown for an invalid date string", () => {
    assert.strictEqual(formatAdminDate("not a date"), "Unknown");
  });

  it("returns Unknown for a raw Firestore Timestamp object that is not serializable", () => {
    assert.strictEqual(formatAdminDate({ _seconds: 1735689600 }), "Unknown");
  });
});

describe("formatAdminDateTime", () => {
  it("formats an ISO date string including time", () => {
    const value = "2025-01-15T12:30:00.000Z";
    const result = formatAdminDateTime(value);
    assert.notStrictEqual(result, "Unknown");
  });

  it("returns Unknown for an invalid value", () => {
    assert.strictEqual(formatAdminDateTime("invalid"), "Unknown");
  });
});
