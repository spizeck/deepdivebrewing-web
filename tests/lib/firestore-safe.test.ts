import { describe, it } from "node:test";
import assert from "node:assert";
import { deepOmitUndefined } from "@/lib/firestore-safe";

// The write boundary that keeps Firestore from rejecting the
// reconciliation report: `undefined` must never reach a document
// payload, at any depth, without losing data that is actually present.

class Sentinel {
  kind = "serverTimestamp";
}

describe("deepOmitUndefined", () => {
  it("drops top-level undefined properties and keeps defined ones", () => {
    const out = deepOmitUndefined({
      keep: "value",
      absent: undefined,
      zero: 0,
      nope: false,
      empty: "",
      nothing: null,
    });
    assert.deepStrictEqual(out, {
      keep: "value",
      zero: 0,
      nope: false,
      empty: "",
      nothing: null,
    });
    assert.ok(!("absent" in out));
  });

  it("drops undefined properties nested inside plain objects", () => {
    const out = deepOmitUndefined({
      view: {
        realmIdShort: undefined,
        currency: "USD",
        range: { from: "2026-05-01", to: "2026-05-31", extra: undefined },
      },
    });
    assert.deepStrictEqual(out, {
      view: {
        currency: "USD",
        range: { from: "2026-05-01", to: "2026-05-31" },
      },
    });
  });

  it("drops undefined properties inside objects nested in arrays", () => {
    const out = deepOmitUndefined({
      qboLedgerItems: [
        {
          entityType: "JournalEntry",
          id: "77",
          txnDate: "2026-05-10",
          docNumber: undefined,
          memo: undefined,
          amountMinor: 1200,
          accountIds: ["34"],
        },
        { kind: "missing_charge", ref: "pay_1", detail: "d", amountMinor: undefined },
      ],
    });
    assert.strictEqual(out.qboLedgerItems.length, 2);
    const first = out.qboLedgerItems[0] as Record<string, unknown>;
    assert.ok(!("docNumber" in first));
    assert.ok(!("memo" in first));
    assert.strictEqual(first.amountMinor, 1200);
    assert.deepStrictEqual(first.accountIds, ["34"]);
    const second = out.qboLedgerItems[1] as Record<string, unknown>;
    assert.ok(!("amountMinor" in second));
    assert.strictEqual(second.ref, "pay_1");
  });

  it("normalizes undefined array elements to null without shifting indices", () => {
    const out = deepOmitUndefined({ list: ["a", undefined, "c"] });
    assert.deepStrictEqual(out.list, ["a", null, "c"]);
  });

  it("passes class instances (FieldValue sentinels, Dates) through untouched", () => {
    const sentinel = new Sentinel();
    const when = new Date("2026-06-01T00:00:00.000Z");
    const out = deepOmitUndefined({ ranAt: sentinel, stamped: when, a: undefined });
    assert.strictEqual(out.ranAt, sentinel);
    assert.strictEqual(out.stamped, when);
    assert.ok(!("a" in out));
  });

  it("preserves empty objects and arrays rather than deleting them", () => {
    const out = deepOmitUndefined({
      flags: [] as unknown[],
      meta: {} as Record<string, unknown>,
      dropped: undefined,
    });
    assert.deepStrictEqual(out.flags, []);
    assert.deepStrictEqual(out.meta, {});
  });

  it("does not mutate the input structure", () => {
    const item = { id: "1", docNumber: undefined as string | undefined };
    const input = { items: [item], extra: undefined as string | undefined };
    deepOmitUndefined(input);
    assert.ok("docNumber" in item);
    assert.ok("extra" in input);
  });

  it("returns primitives unchanged", () => {
    assert.strictEqual(deepOmitUndefined(5), 5);
    assert.strictEqual(deepOmitUndefined("x"), "x");
    assert.strictEqual(deepOmitUndefined(null), null);
    assert.strictEqual(deepOmitUndefined(undefined), undefined);
    assert.strictEqual(deepOmitUndefined(true), true);
  });
});
