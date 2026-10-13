import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildReconFindings,
  classifyStripeBalanceTxn,
  dedupeBalanceTxns,
  qboReconBucketForType,
  resolveChargeAttribution,
  resolveQboReconRange,
  resolveRefundAttribution,
  QBO_RECON_MAX_RANGE_DAYS,
  type DdbStripeIdentity,
  type StripeBalanceTxnFacts,
} from "@/lib/qbo-recon-common";

// Pure-logic coverage for the issue #181 read-only reconciliation
// report: range validation, balance-transaction bucketing, positive-
// identity lane attribution, aggregation math, and finding flags. No
// provider or Firestore IO — that lives in lib/qbo-recon.ts.

function txn(overrides: Partial<StripeBalanceTxnFacts>): StripeBalanceTxnFacts {
  return {
    id: "txn_1",
    type: "charge",
    amountMinor: 1000,
    feeMinor: 30,
    netMinor: 970,
    currency: "USD",
    status: "available",
    ...overrides,
  };
}

function identity(overrides: Partial<DdbStripeIdentity> = {}): DdbStripeIdentity {
  return {
    chargeIds: new Set(),
    paymentIntentIds: new Set(),
    refundIds: new Set(),
    paymentIds: new Set(),
    ...overrides,
  };
}

const NOW = Date.parse("2026-06-15T12:00:00.000Z");

describe("resolveQboReconRange", () => {
  it("defaults to a trailing 30-day window ending today (UTC)", () => {
    const result = resolveQboReconRange({}, NOW);
    assert.ok(result.ok);
    assert.strictEqual(result.range.to, "2026-06-15");
    assert.strictEqual(result.range.from, "2026-05-17");
    assert.strictEqual(result.range.toMsExclusive - result.range.fromMs, 30 * 86_400_000);
  });

  it("accepts an explicit valid window", () => {
    const result = resolveQboReconRange(
      { from: "2026-05-01", to: "2026-05-31" },
      NOW
    );
    assert.ok(result.ok);
    assert.strictEqual(result.range.from, "2026-05-01");
    assert.strictEqual(result.range.to, "2026-05-31");
  });

  it("rejects malformed and normalized-away dates", () => {
    for (const bad of [
      { from: "not-a-date", to: "2026-05-31" },
      { from: "2026-02-31", to: "2026-05-31" },
      { from: "2026/05/01", to: "2026-05-31" },
    ]) {
      const result = resolveQboReconRange(bad, NOW);
      assert.ok(!result.ok, JSON.stringify(bad));
    }
  });

  it("rejects a reversed window, a future end, and an over-span window", () => {
    assert.ok(
      !resolveQboReconRange({ from: "2026-06-01", to: "2026-05-01" }, NOW).ok
    );
    assert.ok(
      !resolveQboReconRange({ from: "2026-06-01", to: "2026-06-20" }, NOW).ok
    );
    const far = new Date(NOW - (QBO_RECON_MAX_RANGE_DAYS + 5) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    assert.ok(
      !resolveQboReconRange({ from: far, to: "2026-06-15" }, NOW).ok
    );
  });
});

describe("qboReconBucketForType", () => {
  it("maps both Stripe naming generations and leaves account movements out of lanes", () => {
    assert.strictEqual(qboReconBucketForType("charge"), "charge");
    assert.strictEqual(qboReconBucketForType("payment"), "charge");
    assert.strictEqual(qboReconBucketForType("refund"), "refund");
    assert.strictEqual(qboReconBucketForType("payment_refund"), "refund");
    assert.strictEqual(qboReconBucketForType("payout"), "payout");
    assert.strictEqual(qboReconBucketForType("payout_cancel"), "payout");
    assert.strictEqual(qboReconBucketForType("adjustment"), "other");
    assert.strictEqual(qboReconBucketForType("stripe_fee"), "other");
    assert.strictEqual(qboReconBucketForType("transfer"), "other");
  });
});

describe("classifyStripeBalanceTxn — positive-identity attribution", () => {
  it("attributes a charge to DDB only through stored identifiers", () => {
    const id = identity({
      chargeIds: new Set(["ch_ddb"]),
      paymentIntentIds: new Set(["pi_ddb"]),
    });
    assert.strictEqual(
      classifyStripeBalanceTxn(txn({ source: "ch_ddb" }), id).attribution,
      "ddb"
    );
    assert.strictEqual(
      classifyStripeBalanceTxn(txn({ source: "pi_ddb" }), id).attribution,
      "ddb"
    );
  });

  it("keeps unmatched charge/refund sources resolvable instead of guessing a lane", () => {
    const id = identity({ chargeIds: new Set(["ch_ddb"]) });
    const charge = classifyStripeBalanceTxn(txn({ source: "ch_ollie" }), id);
    assert.strictEqual(charge.attribution, "unattributed");
    assert.strictEqual(charge.resolvable, true);
    const refund = classifyStripeBalanceTxn(
      txn({ type: "refund", source: "re_x" }),
      id
    );
    assert.strictEqual(refund.attribution, "unattributed");
    assert.strictEqual(refund.resolvable, true);
  });

  it("marks non-resolvable foreign sources external and account movements lane-free", () => {
    const id = identity();
    const external = classifyStripeBalanceTxn(
      txn({ source: "ba_wire" }),
      id
    );
    assert.strictEqual(external.attribution, "external");
    assert.strictEqual(external.resolvable, false);
    const payout = classifyStripeBalanceTxn(
      txn({ type: "payout", source: "po_1", amountMinor: -500, netMinor: -500 }),
      id
    );
    assert.strictEqual(payout.attribution, "account_level");
  });

  it("attributes a refund only through the stored refund id", () => {
    const id = identity({ refundIds: new Set(["re_ddb"]) });
    assert.strictEqual(
      classifyStripeBalanceTxn(txn({ type: "refund", source: "re_ddb" }), id)
        .attribution,
      "ddb"
    );
  });
});

describe("resolveChargeAttribution / resolveRefundAttribution", () => {
  it("resolves DDB on PaymentIntent or metadata.paymentId, never on resemblance", () => {
    const id = identity({
      paymentIntentIds: new Set(["pi_ddb"]),
      paymentIds: new Set(["pay_1"]),
    });
    assert.strictEqual(
      resolveChargeAttribution({ paymentIntentId: "pi_ddb" }, id),
      "ddb"
    );
    assert.strictEqual(
      resolveChargeAttribution({ paymentId: "pay_1" }, id),
      "ddb"
    );
    assert.strictEqual(
      resolveChargeAttribution({ paymentIntentId: "pi_other" }, id),
      "external"
    );
  });

  it("resolves a refund through its owning charge first", () => {
    const id = identity({ chargeIds: new Set(["ch_ddb"]) });
    assert.strictEqual(
      resolveRefundAttribution({ chargeId: "ch_ddb" }, id),
      "ddb"
    );
    assert.strictEqual(resolveRefundAttribution({ chargeId: "ch_x" }, id), "external");
  });
});

describe("dedupeBalanceTxns — duplicate prevention", () => {
  it("counts each provider transaction id once", () => {
    const list = [
      txn({ id: "txn_a" }),
      txn({ id: "txn_b", amountMinor: 500 }),
      txn({ id: "txn_a" }),
    ];
    const out = dedupeBalanceTxns(list);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out.map((t) => t.id), ["txn_a", "txn_b"]);
  });
});

describe("buildReconFindings", () => {
  it("aggregates lanes, signs refunds, and splits pending from available", () => {
    const id = identity({ chargeIds: new Set(["ch_ddb"]), refundIds: new Set(["re_ddb"]) });
    const classified = [
      classifyStripeBalanceTxn(
        txn({ id: "t1", source: "ch_ddb", amountMinor: 1000, feeMinor: 30, netMinor: 970 }),
        id
      ),
      classifyStripeBalanceTxn(
        txn({ id: "t2", type: "refund", source: "re_ddb", amountMinor: -400, feeMinor: 0, netMinor: -400 }),
        id
      ),
      classifyStripeBalanceTxn(
        txn({ id: "t3", source: "ch_ext", amountMinor: 2000, feeMinor: 60, netMinor: 1940, status: "pending" }),
        id
      ),
      classifyStripeBalanceTxn(
        txn({ id: "t4", type: "payout", source: "po_1", amountMinor: -2500, feeMinor: 0, netMinor: -2500 }),
        id
      ),
    ];
    // t3 is ch_-sourced but unmatched → enrich resolves it external here.
    const matched = new Set<string>();
    const { totals, flags } = buildReconFindings(classified, [], matched, "USD");
    assert.strictEqual(totals.txnCount, 4);
    assert.strictEqual(totals.grossChargesDdbMinor, 1000);
    assert.strictEqual(totals.feesDdbMinor, 30);
    assert.strictEqual(totals.refundsDdbMinor, 400);
    assert.strictEqual(totals.netDdbMinor, 570);
    // ch_ext stayed unattributed (no enrichment in this test).
    assert.strictEqual(totals.unattributedCount, 1);
    assert.strictEqual(totals.unattributedGrossMinor, 2000);
    assert.strictEqual(totals.payoutCount, 1);
    assert.strictEqual(totals.payoutNetMinor, -2500);
    // Pending/available split is by Stripe status, not lane.
    assert.strictEqual(totals.pendingNetMinor, 1940);
    assert.strictEqual(totals.availableNetMinor, 970 - 400 - 2500);
    assert.ok(flags.some((f) => f.kind === "unattributed_charge"));
  });

  it("flags a settled payment with no matching charge, and an amount mismatch", () => {
    const id = identity({ chargeIds: new Set(["ch_ddb"]) });
    const classified = [
      classifyStripeBalanceTxn(
        txn({ id: "t1", source: "ch_ddb", amountMinor: 900, feeMinor: 27, netMinor: 873 }),
        id
      ),
    ];
    const payments = [
      {
        paymentId: "pay_match",
        amountMinor: 1000,
        currency: "USD",
        chargeId: "ch_ddb",
        expectsCharge: true,
        expectsRefund: false,
      },
      {
        paymentId: "pay_missing",
        amountMinor: 500,
        currency: "USD",
        chargeId: "ch_nowhere",
        expectsCharge: true,
        expectsRefund: false,
      },
    ];
    const { flags } = buildReconFindings(classified, payments, new Set(), "USD");
    const kinds = flags.map((f) => `${f.kind}:${f.ref}`);
    assert.ok(kinds.includes("amount_mismatch:pay_match"));
    assert.ok(kinds.includes("missing_charge:pay_missing"));
  });

  it("flags a recorded refund absent from Stripe and a currency mismatch", () => {
    const id = identity();
    const classified = [
      classifyStripeBalanceTxn(
        txn({ id: "t1", source: "ch_x", currency: "EUR" }),
        id
      ),
    ];
    const payments = [
      {
        paymentId: "pay_ref",
        amountMinor: 300,
        currency: "USD",
        refundId: "re_absent",
        expectsCharge: false,
        expectsRefund: true,
      },
    ];
    const { flags } = buildReconFindings(classified, payments, new Set(), "USD");
    const kinds = flags.map((f) => f.kind);
    assert.ok(kinds.includes("currency_mismatch"));
    assert.ok(kinds.includes("missing_refund"));
  });

  it("never attributes account-level movements to a lane", () => {
    const classified = [
      classifyStripeBalanceTxn(
        txn({ id: "t1", type: "adjustment", source: "adj_1", amountMinor: 42, netMinor: 42 }),
        identity()
      ),
    ];
    const { totals } = buildReconFindings(classified, [], new Set(), "USD");
    assert.strictEqual(totals.otherCount, 1);
    assert.strictEqual(totals.otherNetMinor, 42);
    assert.strictEqual(totals.grossChargesDdbMinor, 0);
    assert.strictEqual(totals.grossChargesExternalMinor, 0);
  });
});
