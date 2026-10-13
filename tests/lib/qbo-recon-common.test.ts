import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildDdbPaymentScan,
  buildReconFindings,
  classifyStripeBalanceTxn,
  dedupeBalanceTxns,
  qboReconBucketForType,
  resolveChargeAttribution,
  resolveQboReconRange,
  resolveRefundAttribution,
  QBO_RECON_MAX_RANGE_DAYS,
  type DdbStripeIdentity,
  type ReconMatchResolution,
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

function emptyResolution(): ReconMatchResolution {
  return { paymentIds: new Set(), chargesByIntentId: new Map() };
}

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
    const { totals, flags } = buildReconFindings(
      classified,
      [],
      emptyResolution(),
      "USD"
    );
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
    const { flags } = buildReconFindings(
      classified,
      payments,
      emptyResolution(),
      "USD"
    );
    const kinds = flags.map((f) => `${f.kind}:${f.ref}`);
    assert.ok(kinds.includes("amount_mismatch:pay_match"));
    assert.ok(kinds.includes("missing_charge:pay_missing"));
  });

  it("matches a payment through an enrichment-resolved PaymentIntent — no false missing charge", () => {
    // Regression: a payment that recorded only its PaymentIntent id used
    // to flag missing_charge even after enrichment resolved the charge
    // transaction to DDB.
    const chargeTxn = txn({
      id: "t1",
      source: "ch_resolved",
      amountMinor: 1000,
      feeMinor: 30,
      netMinor: 970,
    });
    const classified = [
      {
        txn: chargeTxn,
        bucket: "charge" as const,
        attribution: "ddb" as const,
        resolvable: false,
      },
    ];
    const payments = [
      {
        paymentId: "pay_pi",
        amountMinor: 1000,
        currency: "USD",
        paymentIntentId: "pi_ddb",
        expectsCharge: true,
        expectsRefund: false,
      },
    ];
    const { flags } = buildReconFindings(
      classified,
      payments,
      {
        paymentIds: new Set(),
        chargesByIntentId: new Map([["pi_ddb", chargeTxn]]),
      },
      "USD"
    );
    assert.ok(!flags.some((f) => f.kind === "missing_charge"));
    assert.ok(!flags.some((f) => f.kind === "amount_mismatch"));
  });

  it("still flags an amount mismatch on a PaymentIntent-resolved charge", () => {
    const chargeTxn = txn({
      id: "t1",
      source: "ch_resolved",
      amountMinor: 900,
      feeMinor: 27,
      netMinor: 873,
    });
    const classified = [
      {
        txn: chargeTxn,
        bucket: "charge" as const,
        attribution: "ddb" as const,
        resolvable: false,
      },
    ];
    const payments = [
      {
        paymentId: "pay_pi",
        amountMinor: 1000,
        currency: "USD",
        paymentIntentId: "pi_ddb",
        expectsCharge: true,
        expectsRefund: false,
      },
    ];
    const { flags } = buildReconFindings(
      classified,
      payments,
      {
        paymentIds: new Set(),
        chargesByIntentId: new Map([["pi_ddb", chargeTxn]]),
      },
      "USD"
    );
    const kinds = flags.map((f) => `${f.kind}:${f.ref}`);
    assert.ok(kinds.includes("amount_mismatch:pay_pi"));
    assert.ok(!kinds.includes("missing_charge:pay_pi"));
  });

  it("matches a charge whose Stripe source is the PaymentIntent itself", () => {
    const id = identity({ paymentIntentIds: new Set(["pi_ddb"]) });
    const classified = [
      classifyStripeBalanceTxn(
        txn({ id: "t1", source: "pi_ddb", amountMinor: 1000, feeMinor: 30, netMinor: 970 }),
        id
      ),
    ];
    const payments = [
      {
        paymentId: "pay_pi",
        amountMinor: 1000,
        currency: "USD",
        paymentIntentId: "pi_ddb",
        expectsCharge: true,
        expectsRefund: false,
      },
    ];
    const { flags } = buildReconFindings(
      classified,
      payments,
      emptyResolution(),
      "USD"
    );
    assert.ok(!flags.some((f) => f.kind === "missing_charge"));
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
    const { flags } = buildReconFindings(
      classified,
      payments,
      emptyResolution(),
      "USD"
    );
    const kinds = flags.map((f) => f.kind);
    assert.ok(kinds.includes("currency_mismatch"));
    assert.ok(kinds.includes("missing_refund"));
  });

  it("flags a foreign-currency transaction but excludes it from every monetary total", () => {
    // Regression: an EUR movement used to inflate the USD lane, payout,
    // and available/pending totals after being flagged.
    const id = identity({ chargeIds: new Set(["ch_ddb"]) });
    const classified = [
      classifyStripeBalanceTxn(
        txn({ id: "t1", source: "ch_ddb", amountMinor: 1000, feeMinor: 30, netMinor: 970 }),
        id
      ),
      classifyStripeBalanceTxn(
        txn({ id: "t2", source: "ch_eur", currency: "EUR", amountMinor: 5000, feeMinor: 100, netMinor: 4900 }),
        id
      ),
    ];
    const { totals, flags } = buildReconFindings(
      classified,
      [],
      emptyResolution(),
      "USD"
    );
    assert.ok(flags.some((f) => f.kind === "currency_mismatch" && f.ref === "t2"));
    // The EUR transaction still counts as examined but contributes
    // nothing monetary.
    assert.strictEqual(totals.txnCount, 2);
    assert.strictEqual(totals.grossChargesDdbMinor, 1000);
    assert.strictEqual(totals.feesDdbMinor, 30);
    assert.strictEqual(totals.netDdbMinor, 970);
    assert.strictEqual(totals.availableNetMinor, 970);
    assert.strictEqual(totals.pendingNetMinor, 0);
    assert.strictEqual(totals.grossChargesExternalMinor, 0);
    assert.strictEqual(totals.unattributedGrossMinor, 0);
    assert.strictEqual(totals.unattributedCount, 0);
  });

  it("never attributes account-level movements to a lane", () => {
    const classified = [
      classifyStripeBalanceTxn(
        txn({ id: "t1", type: "adjustment", source: "adj_1", amountMinor: 42, netMinor: 42 }),
        identity()
      ),
    ];
    const { totals } = buildReconFindings(
      classified,
      [],
      emptyResolution(),
      "USD"
    );
    assert.strictEqual(totals.otherCount, 1);
    assert.strictEqual(totals.otherNetMinor, 42);
    assert.strictEqual(totals.grossChargesDdbMinor, 0);
    assert.strictEqual(totals.grossChargesExternalMinor, 0);
  });
});

describe("buildDdbPaymentScan — merged paid/refunded windows", () => {
  const range = {
    fromMs: Date.parse("2026-05-01T00:00:00.000Z"),
    toMsExclusive: Date.parse("2026-06-01T00:00:00.000Z"),
  };

  it("expects a charge only when the payment itself settled in range", () => {
    const { facts } = buildDdbPaymentScan(
      [
        {
          paymentId: "pay_in",
          status: "paid",
          paymentMethod: "card",
          paidAtMs: range.fromMs + 1000,
          amountMinor: 1000,
          currency: "usd",
          chargeId: "ch_1",
        },
        {
          paymentId: "pay_before",
          status: "paid",
          paymentMethod: "card",
          paidAtMs: range.fromMs - 1000,
          amountMinor: 500,
          chargeId: "ch_0",
        },
      ],
      range
    );
    const byId = new Map(facts.map((f) => [f.paymentId, f]));
    assert.strictEqual(byId.get("pay_in")?.expectsCharge, true);
    // Regression: a payment included via the refund window must not be
    // expected to produce a charge inside the current window.
    assert.strictEqual(byId.get("pay_before")?.expectsCharge, false);
  });

  it("attributes an in-window refund of an earlier payment without expecting the charge", () => {
    const { identity, facts } = buildDdbPaymentScan(
      [
        {
          paymentId: "pay_old",
          status: "refunded",
          paymentMethod: "card",
          paidAtMs: range.fromMs - 30 * 86_400_000,
          refundedAtMs: range.fromMs + 86_400_000,
          amountMinor: 800,
          currency: "USD",
          chargeId: "ch_old",
          refundId: "re_old",
        },
      ],
      range
    );
    // Positive identity covers the refund and its owning charge even
    // though paidAt predates the window.
    assert.ok(identity.refundIds.has("re_old"));
    assert.ok(identity.chargeIds.has("ch_old"));
    assert.ok(identity.paymentIds.has("pay_old"));
    const fact = facts.find((f) => f.paymentId === "pay_old");
    assert.strictEqual(fact?.expectsRefund, true);
    assert.strictEqual(fact?.expectsCharge, false);
  });

  it("contributes no identity or expectations for cash payments and non-settled records", () => {
    const { identity, facts } = buildDdbPaymentScan(
      [
        {
          paymentId: "pay_cash",
          status: "paid",
          paymentMethod: "cash",
          paidAtMs: range.fromMs + 1000,
        },
        {
          paymentId: "pay_pending",
          status: "pending",
          paymentMethod: "card",
          paidAtMs: range.fromMs + 1000,
        },
      ],
      range
    );
    assert.strictEqual(identity.paymentIds.size, 1);
    assert.strictEqual(identity.paymentIds.has("pay_cash"), true);
    const fact = facts.find((f) => f.paymentId === "pay_cash");
    assert.strictEqual(fact?.expectsCharge, false);
    assert.strictEqual(fact?.expectsRefund, false);
  });
});
