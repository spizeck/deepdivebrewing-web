import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDdbPaymentIndex,
  buildPayoutLedger,
  buildPayoutProposals,
  matchOlliePayment,
  qboProposalIdFor,
  STRIPE_PAYOUT_EVENT_TYPES,
  STRIPE_PAYOUT_LEDGER_TRIGGERS,
  type QboUndepositedPayment,
  type StripePayoutFacts,
  type StripePayoutTxn,
} from "@/lib/stripe-payouts-common";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-15T12:00:00.000Z");

function payout(overrides: Partial<StripePayoutFacts> = {}): StripePayoutFacts {
  return {
    id: "po_123",
    status: "paid",
    amountMinor: 9680,
    currency: "USD",
    arrivalDate: "2026-10-15",
    createdMs: NOW - 2 * DAY_MS,
    ...overrides,
  };
}

function charge(
  overrides: Partial<StripePayoutTxn> = {}
): StripePayoutTxn {
  return {
    txnId: "txn_1",
    type: "charge",
    grossMinor: 10000,
    feeMinor: 320,
    netMinor: 9680,
    currency: "USD",
    sourceId: "ch_1",
    createdMs: NOW - 4 * DAY_MS,
    ...overrides,
  };
}

function olliePayment(
  overrides: Partial<QboUndepositedPayment> = {}
): QboUndepositedPayment {
  return {
    id: "42",
    txnDate: "2026-10-11",
    totalMinor: 10000,
    depositToAccountId: "uf-1",
    currency: "USD",
    customerName: "Sea Saba",
    refNumber: "Ollie Payment #1626166",
    linkedTxnIds: ["inv-1"],
    ...overrides,
  };
}

function emptyInput(overrides = {}) {
  return {
    payout: payout(),
    txns: [] as StripePayoutTxn[],
    ddbIndex: buildDdbPaymentIndex([]),
    resolvedChargeFacts: new Map(),
    ollieCandidates: [] as QboUndepositedPayment[],
    claimedPaymentIds: new Set<string>(),
    ...overrides,
  };
}

describe("payout event vocabulary", () => {
  it("covers the lifecycle events and ledger triggers", () => {
    for (const type of [
      "payout.created",
      "payout.updated",
      "payout.paid",
      "payout.failed",
      "payout.canceled",
      "payout.reconciliation_completed",
    ]) {
      assert.ok(STRIPE_PAYOUT_EVENT_TYPES.has(type), type);
    }
    assert.ok(STRIPE_PAYOUT_LEDGER_TRIGGERS.has("payout.paid"));
    assert.ok(
      STRIPE_PAYOUT_LEDGER_TRIGGERS.has("payout.reconciliation_completed")
    );
    assert.ok(!STRIPE_PAYOUT_LEDGER_TRIGGERS.has("payout.created"));
  });
});

describe("matchOlliePayment", () => {
  it("suggests a unique amount+currency+window match", () => {
    const result = matchOlliePayment(
      { amountMinor: 10000, currency: "USD", createdMs: NOW - 4 * DAY_MS },
      [olliePayment()],
      "USD"
    );
    assert.equal(result.confidence, "suggested");
    assert.equal(result.payment?.id, "42");
    assert.ok(result.evidence.includes("exact_amount"));
    assert.ok(result.evidence.includes("currency_match"));
    assert.ok(result.evidence.includes("date_in_window"));
  });

  it("rejects a candidate outside the date window", () => {
    const result = matchOlliePayment(
      { amountMinor: 10000, currency: "USD", createdMs: NOW - 40 * DAY_MS },
      [olliePayment()],
      "USD"
    );
    assert.equal(result.confidence, "unmatched");
  });

  it("rejects a candidate with a different QBO currency", () => {
    const result = matchOlliePayment(
      { amountMinor: 10000, currency: "USD", createdMs: NOW },
      [olliePayment({ currency: "EUR" })],
      "USD"
    );
    assert.equal(result.confidence, "unmatched");
  });

  it("never matches a foreign-currency charge", () => {
    const result = matchOlliePayment(
      { amountMinor: 10000, currency: "EUR", createdMs: NOW },
      [olliePayment()],
      "USD"
    );
    assert.equal(result.confidence, "unmatched");
    assert.ok(result.evidence.includes("foreign_currency"));
  });

  it("marks multiple matching candidates ambiguous — never picks one", () => {
    const result = matchOlliePayment(
      { amountMinor: 10000, currency: "USD", createdMs: NOW - 4 * DAY_MS },
      [olliePayment(), olliePayment({ id: "43" })],
      "USD"
    );
    assert.equal(result.confidence, "ambiguous");
    assert.deepEqual(result.candidateIds.sort(), ["42", "43"]);
  });

  it("does not match by amount alone when amounts differ", () => {
    const result = matchOlliePayment(
      { amountMinor: 9999, currency: "USD", createdMs: NOW },
      [olliePayment()],
      "USD"
    );
    assert.equal(result.confidence, "unmatched");
  });
});

describe("buildPayoutLedger", () => {
  it("classifies a DDB-owned charge by stored identity, never proposing it", () => {
    const txn = charge();
    const index = buildDdbPaymentIndex([
      { paymentId: "pay_1", chargeId: "ch_1" },
    ]);
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [txn],
        ddbIndex: index,
        // A tempting Ollie candidate exists too — DDB identity wins.
        ollieCandidates: [olliePayment()],
      })
    );
    assert.equal(ledger.lines[0].lane, "ddb");
    assert.equal(ledger.lines[0].confidence, "confirmed");
    assert.equal(ledger.lines[0].paymentId, "pay_1");
    assert.equal(ledger.lines[0].qboPaymentId, undefined);
  });

  it("confirms identity via enriched PaymentIntent when no charge id is stored", () => {
    const index = buildDdbPaymentIndex([
      { paymentId: "pay_2", paymentIntentId: "pi_9" },
    ]);
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [charge({ sourceId: "ch_x" })],
        ddbIndex: index,
        resolvedChargeFacts: new Map([
          ["ch_x", { paymentIntentId: "pi_9" }],
        ]),
      })
    );
    assert.equal(ledger.lines[0].lane, "ddb");
    assert.equal(ledger.lines[0].paymentId, "pay_2");
  });

  it("suggests a unique Ollie payment for a non-DDB charge", () => {
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [charge({ sourceId: "ch_ollie" })],
        ollieCandidates: [olliePayment()],
      })
    );
    assert.equal(ledger.lines[0].lane, "ollie");
    assert.equal(ledger.lines[0].confidence, "suggested");
    assert.equal(ledger.lines[0].qboPaymentId, "42");
    assert.equal(ledger.lines[0].qboPaymentRef, "Ollie Payment #1626166");
    assert.deepEqual(ledger.claimedByThisPayout, ["42"]);
  });

  it("treats a claimed Ollie payment as unavailable for a second payout", () => {
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [charge({ sourceId: "ch_ollie" })],
        ollieCandidates: [olliePayment()],
        claimedPaymentIds: new Set(["42"]),
      })
    );
    assert.equal(ledger.lines[0].lane, "external");
    assert.equal(ledger.lines[0].confidence, "unmatched");
  });

  it("flags ambiguity as an exception with no proposal target", () => {
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [charge({ sourceId: "ch_ollie" })],
        ollieCandidates: [olliePayment(), olliePayment({ id: "77" })],
      })
    );
    assert.equal(ledger.lines[0].lane, "external");
    assert.equal(ledger.lines[0].confidence, "ambiguous");
    assert.ok(
      ledger.exceptions.some((e) => e.code === "ambiguous_match")
    );
  });

  it("reconciles a payout with charge + refund + fee math", () => {
    const ledger = buildPayoutLedger(
      emptyInput({
        payout: payout({ amountMinor: 9480 }), // 10000 - 320 fee - 200 refund
        txns: [
          charge(),
          {
            txnId: "txn_r",
            type: "refund",
            grossMinor: -200,
            feeMinor: 0,
            netMinor: -200,
            currency: "USD",
            sourceId: "re_1",
            createdMs: NOW - 3 * DAY_MS,
          },
        ],
      })
    );
    assert.equal(ledger.totals.chargeCount, 1);
    assert.equal(ledger.totals.grossChargesMinor, 10000);
    assert.equal(ledger.totals.feesMinor, 320);
    assert.equal(ledger.totals.refundCount, 1);
    assert.equal(ledger.totals.refundsMinor, 200);
    assert.equal(ledger.totals.computedNetMinor, 9480);
    assert.equal(ledger.totals.balanced, true);
  });

  it("marks the ledger unbalanced when lines do not sum to the payout", () => {
    const ledger = buildPayoutLedger(
      emptyInput({
        payout: payout({ amountMinor: 9999 }),
        txns: [charge()],
      })
    );
    assert.equal(ledger.totals.balanced, false);
  });

  it("excludes foreign-currency lines from totals and flags them", () => {
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [
          charge(),
          charge({
            txnId: "txn_eur",
            currency: "EUR",
            grossMinor: 5000,
            feeMinor: 100,
            netMinor: 4900,
            sourceId: "ch_eur",
          }),
        ],
      })
    );
    assert.equal(ledger.totals.currencyConsistent, false);
    assert.equal(ledger.totals.computedNetMinor, 9680); // USD line only
    assert.ok(
      ledger.exceptions.some((e) => e.code === "foreign_currency")
    );
    assert.equal(ledger.lines[1].scope, "foreign_currency");
  });

  it("classifies pre-cutover movements but flags them unproposable", () => {
    const cutover = "2026-10-10";
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [charge({ createdMs: NOW - 30 * DAY_MS })],
        ollieCandidates: [
          olliePayment({ txnDate: "2026-09-15" }),
        ],
        cutover,
      })
    );
    assert.equal(ledger.lines[0].scope, "pre_cutover");
    assert.ok(
      ledger.exceptions.some((e) => e.code === "cutover_skipped")
    );
  });

  it("keeps account-level movements out of matching entirely", () => {
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [
          {
            txnId: "txn_fee",
            type: "adjustment",
            grossMinor: -50,
            feeMinor: 0,
            netMinor: -50,
            currency: "USD",
            createdMs: NOW,
          },
        ],
      })
    );
    assert.equal(ledger.lines[0].lane, "account_level");
    assert.equal(ledger.lines[0].confidence, "none");
    assert.equal(ledger.exceptions.length, 0);
  });
});

describe("buildPayoutProposals", () => {
  const mapping = {
    stripeClearingAccountId: "clearing-1",
    stripeFeeExpenseAccountId: "fee-1",
    stripePayoutAccountId: "bank-1",
  };

  function proposedLedger() {
    return buildPayoutLedger(
      emptyInput({
        txns: [charge({ sourceId: "ch_ollie" })],
        ollieCandidates: [olliePayment()],
      })
    );
  }

  it("proposes all three entries for a suggested Ollie match", () => {
    const proposals = buildPayoutProposals({
      environment: "sandbox",
      payout: payout(),
      ledger: proposedLedger(),
      mode: "observe",
      mapping,
    });
    const kinds = proposals.map((p) => p.kind).sort();
    assert.deepEqual(kinds, [
      "move_payment_to_clearing",
      "payout_transfer",
      "stripe_fee_expense",
    ]);
    const move = proposals.find((p) => p.kind === "move_payment_to_clearing")!;
    assert.equal(move.amountMinor, 10000);
    assert.equal(move.qboRefs.paymentId, "42");
    assert.equal(move.status, "proposed");
    const fee = proposals.find((p) => p.kind === "stripe_fee_expense")!;
    assert.equal(fee.amountMinor, 320);
    const transfer = proposals.find((p) => p.kind === "payout_transfer")!;
    assert.equal(transfer.amountMinor, 9680);
    assert.equal(transfer.debit.accountId, "bank-1");
    assert.equal(transfer.credit.accountId, "clearing-1");
  });

  it("blocks proposals when mappings are absent", () => {
    const proposals = buildPayoutProposals({
      environment: "sandbox",
      payout: payout(),
      ledger: proposedLedger(),
      mode: "observe",
      mapping: {},
    });
    assert.ok(proposals.every((p) => p.status === "blocked"));
    assert.ok(
      proposals.every((p) => p.evidence.some((e) => e.endsWith("_unmapped")))
    );
  });

  it("suppresses proposals covered by existing manual QBO entries", () => {
    const proposals = buildPayoutProposals({
      environment: "sandbox",
      payout: payout(),
      ledger: proposedLedger(),
      mode: "observe",
      mapping,
      existingCover: { hasFeeEntry: true, hasTransferEntry: true },
    });
    assert.equal(
      proposals.find((p) => p.kind === "stripe_fee_expense"),
      undefined
    );
    assert.equal(
      proposals.find((p) => p.kind === "payout_transfer"),
      undefined
    );
    // The payment reclassification is still proposed — a manual fee or
    // transfer entry does not cover the UF→Clearing payment move.
    assert.ok(
      proposals.some((p) => p.kind === "move_payment_to_clearing")
    );
  });

  it("proposes nothing for DDB-owned, external, or pre-cutover lines", () => {
    const index = buildDdbPaymentIndex([
      { paymentId: "pay_1", chargeId: "ch_1" },
    ]);
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [
          charge(), // ddb
          charge({
            txnId: "t2",
            sourceId: "ch_old",
            createdMs: NOW - 30 * DAY_MS,
          }), // pre-cutover
        ],
        ddbIndex: index,
        ollieCandidates: [olliePayment({ txnDate: "2026-09-15" })],
        cutover: "2026-10-10",
      })
    );
    const proposals = buildPayoutProposals({
      environment: "sandbox",
      payout: payout(),
      ledger,
      mode: "observe",
      mapping,
    });
    assert.equal(
      proposals.some((p) => p.kind === "move_payment_to_clearing"),
      false
    );
  });

  it("skips aggregate proposals when every line is pre-cutover", () => {
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [charge({ createdMs: NOW - 30 * DAY_MS })],
        cutover: "2026-10-10",
      })
    );
    const proposals = buildPayoutProposals({
      environment: "sandbox",
      payout: payout(),
      ledger,
      mode: "observe",
      mapping,
    });
    assert.equal(proposals.length, 0);
  });

  it("scopes the fee proposal to eligible lines on a cutover-straddling payout", () => {
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [
          // Eligible: post-cutover charge.
          charge({ txnId: "t_new", sourceId: "ch_new", grossMinor: 10000, feeMinor: 320, netMinor: 9680 }),
          // Pre-cutover charge with its own fee — must not leak into the
          // proposed fee expense.
          charge({ txnId: "t_old", sourceId: "ch_old", grossMinor: 5000, feeMinor: 200, netMinor: 4800, createdMs: NOW - 30 * DAY_MS }),
        ],
        cutover: "2026-10-10",
      })
    );
    const proposals = buildPayoutProposals({
      environment: "sandbox",
      payout: payout({ amountMinor: 14480 }),
      ledger,
      mode: "observe",
      mapping,
    });
    const fee = proposals.find((p) => p.kind === "stripe_fee_expense")!;
    assert.equal(fee.amountMinor, 320); // eligible charge's fee only
    assert.ok(fee.evidence.includes("partial_scope_eligible_lines_only"));
  });

  it("withholds the transfer proposal on a mixed-scope payout", () => {
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [
          charge({ txnId: "t_new", sourceId: "ch_new" }),
          charge({ txnId: "t_old", sourceId: "ch_old", createdMs: NOW - 30 * DAY_MS }),
        ],
        cutover: "2026-10-10",
      })
    );
    const proposals = buildPayoutProposals({
      environment: "sandbox",
      payout: payout(),
      ledger,
      mode: "observe",
      mapping,
    });
    // The bank deposit covers the full payout including the pre-cutover
    // share — proposing it would double-count manual history, so the
    // transfer waits for a human and the line carries the exception.
    assert.equal(
      proposals.find((p) => p.kind === "payout_transfer"),
      undefined
    );
    assert.ok(ledger.exceptions.some((e) => e.code === "cutover_skipped"));
  });

  it("does not propose a transfer for an unpaid payout", () => {
    const proposals = buildPayoutProposals({
      environment: "sandbox",
      payout: payout({ status: "in_transit" }),
      ledger: proposedLedger(),
      mode: "observe",
      mapping,
    });
    assert.equal(
      proposals.some((p) => p.kind === "payout_transfer"),
      false
    );
  });

  it("generates deterministic proposal ids stable across recomputes", () => {
    const a = buildPayoutProposals({
      environment: "sandbox",
      payout: payout(),
      ledger: proposedLedger(),
      mode: "observe",
      mapping,
    });
    const b = buildPayoutProposals({
      environment: "sandbox",
      payout: payout(),
      ledger: proposedLedger(),
      mode: "observe",
      mapping,
    });
    assert.deepEqual(
      a.map((p) => p.proposalId).sort(),
      b.map((p) => p.proposalId).sort()
    );
    assert.equal(
      qboProposalIdFor("sandbox", "po_123", "move_payment_to_clearing", "42"),
      "sandbox:po_123:move_payment_to_clearing:42"
    );
  });

  it("environment-scopes proposal ids so sandbox and production cannot collide", () => {
    assert.notEqual(
      qboProposalIdFor("sandbox", "po_1", "payout_transfer", "aggregate"),
      qboProposalIdFor("production", "po_1", "payout_transfer", "aggregate")
    );
  });
});
