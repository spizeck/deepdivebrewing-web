import { describe, it } from "node:test";
import assert from "node:assert";
import {
  abbreviateRealmId,
  isQboDiscoveryEntityType,
  isQboEnvironment,
  normalizeQboSyncCandidate,
  qboEnvironmentLabel,
  qboIncomeItemKeyForPurpose,
  qboMissingMappingFields,
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
  it("builds a deterministic, environment-scoped key from the source identity", () => {
    assert.strictEqual(
      qboSyncIdFor("sandbox", "stripe_payment", "pay_123"),
      "sandbox:stripe_payment:pay_123"
    );
    assert.strictEqual(
      qboSyncIdFor("production", " stripe_payment ", " pay_123 "),
      "production:stripe_payment:pay_123"
    );
    // Sandbox and production identities for the same event never collide.
    assert.notStrictEqual(
      qboSyncIdFor("sandbox", "stripe_payment", "pay_123"),
      qboSyncIdFor("production", "stripe_payment", "pay_123")
    );
  });

  it("refuses empty identities", () => {
    assert.throws(() => qboSyncIdFor("sandbox", "", "x"));
    assert.throws(() => qboSyncIdFor("sandbox", "t", " "));
  });
});

describe("qboIncomeItemKeyForPurpose", () => {
  it("maps the canonical purpose table (design §6)", () => {
    const cases = [
      ["brewery_tour", "tourIncomeItemId"],
      ["additional_guests", "tourIncomeItemId"],
      ["private_tour", "tourIncomeItemId"],
      ["brewery_tour_tasting", "tastingIncomeItemId"],
      ["other", "otherIncomeItemId"],
    ] as const;
    for (const [purpose, key] of cases) {
      assert.strictEqual(qboIncomeItemKeyForPurpose(purpose), key, purpose);
    }
  });

  it("fails closed for unknown or absent purposes", () => {
    for (const purpose of ["gift_card", "", "OTHER", undefined]) {
      assert.strictEqual(
        qboIncomeItemKeyForPurpose(purpose),
        null,
        String(purpose)
      );
    }
  });
});

describe("qboMissingMappingFields", () => {
  const complete = {
    stripeClearingAccountId: "a",
    cardPaymentMethodId: "pm",
    tourIncomeItemId: "t",
    tastingIncomeItemId: "s",
    otherIncomeItemId: "o",
    fallbackCustomerId: "c",
  };

  it("reports every required field when nothing is mapped", () => {
    assert.deepStrictEqual(qboMissingMappingFields({}), [
      "stripeClearingAccountId",
      "cardPaymentMethodId",
      "tourIncomeItemId",
      "tastingIncomeItemId",
      "otherIncomeItemId",
      "fallbackCustomerId",
    ]);
    assert.deepStrictEqual(qboMissingMappingFields(undefined), [
      "stripeClearingAccountId",
      "cardPaymentMethodId",
      "tourIncomeItemId",
      "tastingIncomeItemId",
      "otherIncomeItemId",
      "fallbackCustomerId",
    ]);
  });

  it("is empty for a complete mapping even without a tax code", () => {
    assert.deepStrictEqual(qboMissingMappingFields(complete), []);
    assert.deepStrictEqual(
      qboMissingMappingFields({ ...complete, taxCodeId: "tax" }),
      []
    );
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
