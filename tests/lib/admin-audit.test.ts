import { describe, it } from "node:test";
import assert from "node:assert";
import { dropUndefinedValues } from "@/lib/admin-audit-common";

describe("dropUndefinedValues", () => {
  it("removes undefined fields from the top level", () => {
    const result = dropUndefinedValues({ a: 1, b: undefined, c: "ok" });
    assert.deepStrictEqual(result, { a: 1, c: "ok" });
  });

  it("removes undefined values from nested metadata objects", () => {
    const result = dropUndefinedValues({
      action: "test",
      metadata: { invitationId: "invite-1", extra: undefined },
    });
    assert.deepStrictEqual(result, {
      action: "test",
      metadata: { invitationId: "invite-1" },
    });
  });

  it("keeps null values", () => {
    const result = dropUndefinedValues({ a: null, b: undefined });
    assert.deepStrictEqual(result, { a: null });
  });

  it("returns primitives unchanged", () => {
    assert.strictEqual(dropUndefinedValues("string"), "string");
    assert.strictEqual(dropUndefinedValues(42), 42);
    assert.strictEqual(dropUndefinedValues(null), null);
    assert.strictEqual(dropUndefinedValues(undefined), undefined);
  });

  it("preserves class instances instead of destructuring them", () => {
    const date = new Date("2025-01-01T00:00:00.000Z");
    class Box {
      constructor(public value: unknown) {}
    }
    const box = new Box("keep");
    const result = dropUndefinedValues({
      date,
      box,
      removed: undefined,
    }) as { date: Date; box: Box };
    assert.strictEqual(result.date, date);
    assert.strictEqual(result.box, box);
  });
});
