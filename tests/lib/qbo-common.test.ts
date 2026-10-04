import { describe, it } from "node:test";
import assert from "node:assert";
import {
  abbreviateRealmId,
  isQboDiscoveryEntityType,
  isQboEnvironment,
  normalizeQboSyncCandidate,
  qboEnvironmentLabel,
  qboSyncIdFor,
} from "@/lib/qbo-common";

describe("abbreviateRealmId", () => {
  it("abbreviates long realm ids and keeps short ones", () => {
    assert.strictEqual(
      abbreviateRealmId("4620816365507846020"),
      "4620…6020"
    );
    assert.strictEqual(abbreviateRealmId("1234"), "1234");
  });
});

describe("isQboEnvironment / label", () => {
  it("recognizes the two environments only", () => {
    assert.strictEqual(isQboEnvironment("sandbox"), true);
    assert.strictEqual(isQboEnvironment("production"), true);
    assert.strictEqual(isQboEnvironment("staging"), false);
    assert.strictEqual(qboEnvironmentLabel("sandbox"), "Sandbox");
    assert.strictEqual(qboEnvironmentLabel("production"), "Production");
  });
});

describe("isQboDiscoveryEntityType", () => {
  it("accepts the supported entity types", () => {
    for (const type of ["account", "item", "customer", "payment-method", "tax-code"]) {
      assert.strictEqual(isQboDiscoveryEntityType(type), true, type);
    }
    for (const bad of ["invoice", "ACCOUNT", "", undefined]) {
      assert.strictEqual(isQboDiscoveryEntityType(bad), false, String(bad));
    }
  });
});

describe("qboSyncIdFor", () => {
  it("builds a deterministic key from the source identity", () => {
    assert.strictEqual(
      qboSyncIdFor("stripe_payment", "pay_123"),
      "stripe_payment:pay_123"
    );
    assert.strictEqual(
      qboSyncIdFor(" stripe_payment ", " pay_123 "),
      "stripe_payment:pay_123"
    );
  });

  it("refuses empty identities", () => {
    assert.throws(() => qboSyncIdFor("", "x"));
    assert.throws(() => qboSyncIdFor("t", " "));
  });
});

describe("normalizeQboSyncCandidate", () => {
  const valid = {
    sourceType: "stripe_payment",
    sourceId: "pay_abc123",
    amountMinorUnits: 4500,
    currency: "usd",
    transactionDate: "2026-01-05T12:00:00Z",
    customerName: " Jane Diver ",
    customerEmail: "jane@example.com",
    purpose: "brewery_tour",
    description: "Tour for 4",
    externalRefs: { paymentIntent: "pi_1", charge: "ch_1" },
    tourDate: "2026-02-01",
    attendeeCount: 4,
  };

  it("normalizes a valid candidate", () => {
    const out = normalizeQboSyncCandidate(valid);
    assert.strictEqual(out.currency, "USD");
    assert.strictEqual(out.customerName, "Jane Diver");
    assert.deepStrictEqual(out.externalRefs, {
      paymentIntent: "pi_1",
      charge: "ch_1",
    });
    assert.strictEqual(out.attendeeCount, 4);
  });

  it("rejects malformed required fields", () => {
    const bad = [
      { ...valid, sourceType: "Stripe Payment" },
      { ...valid, sourceType: "" },
      { ...valid, sourceId: "" },
      { ...valid, sourceId: "x".repeat(200) },
      { ...valid, amountMinorUnits: 1.5 },
      { ...valid, amountMinorUnits: "45" },
      { ...valid, currency: "us" },
      { ...valid, currency: "US DOLLARS" },
      { ...valid, transactionDate: "not a date" },
      { ...valid, transactionDate: "" },
    ];
    for (const candidate of bad) {
      assert.throws(
        () => normalizeQboSyncCandidate(candidate as never),
        Error,
        JSON.stringify(candidate).slice(0, 80)
      );
    }
  });

  it("drops unusable optional values rather than failing", () => {
    const out = normalizeQboSyncCandidate({
      ...valid,
      attendeeCount: 0,
      tourDate: "  ",
      externalRefs: undefined,
      description: undefined,
    });
    assert.strictEqual(out.attendeeCount, undefined);
    assert.strictEqual(out.tourDate, undefined);
    assert.strictEqual(out.externalRefs, undefined);
    assert.strictEqual(out.description, undefined);
  });
});
