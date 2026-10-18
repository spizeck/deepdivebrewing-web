import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDdbPaymentIndex,
  buildPayoutLedger,
  buildPayoutProposals,
  ollieIdentityFromChargeFacts,
  type OllieStripeIdentity,
  type QboAccountingProposal,
  type QboUndepositedPayment,
  type StripePayoutFacts,
  type StripePayoutTxn,
} from "@/lib/stripe-payouts-common";

// Representative mixed-source payout scenarios exercised end-to-end
// through the ledger + proposal builders. Each test states the complete
// set of QuickBooks accounting entries the system would propose (and
// which of them qualify for unattended execution), so a reviewer can
// audit the automatic model scenario by scenario. All amounts are
// integer minor units (cents), USD.

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-10-20T12:00:00.000Z");

const MAPPING = {
  stripeClearingAccountId: "34",
  stripeFeeExpenseAccountId: "86",
  stripePayoutAccountId: "99",
};
const ACCOUNT_NAMES = {
  "34": "Stripe Balance",
  "86": "Payment processing fees",
  "99": "MCB Checking",
};

function payout(overrides: Partial<StripePayoutFacts> = {}): StripePayoutFacts {
  return {
    id: "po_scenario",
    status: "paid",
    amountMinor: 0, // set per scenario
    currency: "USD",
    arrivalDate: "2026-10-20",
    createdMs: NOW - 2 * DAY_MS,
    ...overrides,
  };
}

function charge(overrides: Partial<StripePayoutTxn> = {}): StripePayoutTxn {
  return {
    txnId: "txn_1",
    type: "charge",
    grossMinor: 0,
    feeMinor: 0,
    netMinor: 0,
    currency: "USD",
    createdMs: NOW - 4 * DAY_MS,
    ...overrides,
  };
}

/** A charge convenience constructor: gross/fee/net kept consistent. */
function sale(
  txnId: string,
  sourceId: string,
  grossMinor: number,
  feeMinor: number,
  overrides: Partial<StripePayoutTxn> = {}
): StripePayoutTxn {
  return charge({
    txnId,
    sourceId,
    grossMinor,
    feeMinor,
    netMinor: grossMinor - feeMinor,
    ...overrides,
  });
}

function olliePayment(
  overrides: Partial<QboUndepositedPayment> = {}
): QboUndepositedPayment {
  return {
    id: "qpay-1",
    txnDate: "2026-10-16",
    totalMinor: 0,
    depositToAccountId: "uf-1",
    currency: "USD",
    linkedTxnIds: [],
    ...overrides,
  };
}

interface Scenario {
  txns: StripePayoutTxn[];
  ddbRecords?: Parameters<typeof buildDdbPaymentIndex>[0];
  receipts?: [string, string][];
  chargeFacts?: [string, { ollieIdentity?: OllieStripeIdentity }][];
  ollieCandidates?: QboUndepositedPayment[];
  payout?: StripePayoutFacts;
  ledgerComplete?: boolean;
  existingCover?: {
    hasFeeEntry: boolean;
    hasTransferEntry: boolean;
    hasHistoricalFeeEntry?: boolean;
  };
}

function run(scenario: Scenario) {
  const amountMinor = scenario.txns
    .filter((txn) => txn.type !== "payout")
    .reduce((sum, txn) => sum + txn.netMinor, 0);
  const payoutFacts = scenario.payout ?? payout({ amountMinor });
  const ledger = buildPayoutLedger({
    payout: payoutFacts,
    txns: scenario.txns,
    ddbIndex: buildDdbPaymentIndex(scenario.ddbRecords ?? []),
    resolvedChargeFacts: new Map(scenario.chargeFacts ?? []),
    ollieCandidates: scenario.ollieCandidates ?? [],
    claimedPaymentIds: new Set<string>(),
    ddbReceiptStatus: new Map(scenario.receipts ?? []),
    reconciledMoves: new Map(),
    cutover: null,
  });
  const proposals = buildPayoutProposals({
    environment: "sandbox",
    payout: payoutFacts,
    ledger,
    mode: "automatic",
    mapping: MAPPING,
    accountNames: ACCOUNT_NAMES,
    existingCover: scenario.existingCover,
    undepositedFundsId: "uf-1",
    ledgerComplete: scenario.ledgerComplete ?? true,
  });
  return { ledger, proposals, payoutFacts };
}

function byKind(
  proposals: QboAccountingProposal[],
  kind: QboAccountingProposal["kind"]
): QboAccountingProposal[] {
  return proposals.filter((p) => p.kind === kind);
}

describe("scenario: DDB-only payout", () => {
  // Two brewery tour sales paid by card through the web app; both
  // receipts already synced to Stripe clearing. The whole payout is
  // positively identified, so both aggregate entries post unattended.
  const { ledger, proposals } = run({
    txns: [
      sale("txn_d1", "ch_d1", 12000, 378),
      sale("txn_d2", "ch_d2", 8000, 262),
    ],
    ddbRecords: [
      { paymentId: "pay_d1", chargeId: "ch_d1" },
      { paymentId: "pay_d2", chargeId: "ch_d2" },
    ],
    receipts: [
      ["pay_d1", "synced"],
      ["pay_d2", "synced"],
    ],
  });

  it("classifies every line ddb/confirmed and stays balanced", () => {
    assert.equal(ledger.totals.balanced, true);
    assert.ok(ledger.lines.every((l) => l.lane === "ddb" && l.confidence === "confirmed"));
    assert.equal(ledger.exceptions.length, 0);
  });

  it("proposes fee JE + clearing transfer, both auto-eligible", () => {
    assert.equal(proposals.length, 2);
    const fee = byKind(proposals, "stripe_fee_expense")[0];
    assert.equal(fee.amountMinor, 640); // actual Stripe fees, never estimated
    assert.equal(fee.debit.accountId, "86");
    assert.equal(fee.credit.accountId, "34");
    assert.equal(fee.autoEligible, true);
    const transfer = byKind(proposals, "payout_transfer")[0];
    assert.equal(transfer.amountMinor, 19360);
    assert.equal(transfer.debit.accountId, "99");
    assert.equal(transfer.credit.accountId, "34");
    assert.equal(transfer.autoEligible, true);
  });
});

describe("scenario: mixed DDB + verified Ollie (Spreedly two-leg)", () => {
  // One DDB tour sale plus an Ollie wholesale order settled through
  // Spreedly. The charge metadata claims order 00326 / payment 1623638;
  // the QBO payment corroborates both legs (PaymentRefNum and a
  // linked-invoice DocNumber). Everything is identified → fully
  // automatic.
  const { ledger, proposals } = run({
    txns: [
      sale("txn_d1", "ch_d1", 12000, 378),
      sale("txn_o1", "ch_o1", 23000, 697),
      // The payout's own debit line — Stripe includes it in the
      // constituent list; it must not enter the net sum.
      charge({
        txnId: "txn_po",
        type: "payout",
        grossMinor: 33925,
        netMinor: 33925,
      }),
    ],
    ddbRecords: [{ paymentId: "pay_d1", chargeId: "ch_d1" }],
    receipts: [["pay_d1", "synced"]],
    chargeFacts: [
      [
        "ch_o1",
        {
          ollieIdentity: ollieIdentityFromChargeFacts({
            metadata: {
              connect_agent: "Spreedly",
              order_id: "00326-1623638",
            },
          }),
        },
      ],
    ],
    ollieCandidates: [
      olliePayment({
        id: "qpay-ol",
        totalMinor: 23000,
        refNumber: "1623638",
        linkedTxnIds: ["inv-326"],
        linkedDocNumbers: ["00326"],
      }),
    ],
  });

  it("classifies the Ollie line verified with spreedly_identity evidence", () => {
    const line = ledger.lines.find((l) => l.txnId === "txn_o1")!;
    assert.equal(line.lane, "ollie");
    assert.equal(line.confidence, "verified");
    assert.ok(line.evidence.includes("spreedly_identity"));
    assert.equal(line.qboPaymentId, "qpay-ol");
    assert.equal(ledger.totals.balanced, true);
  });

  it("proposes all three entries, every one auto-eligible", () => {
    assert.equal(proposals.length, 3);
    const move = byKind(proposals, "move_payment_to_clearing")[0];
    assert.equal(move.amountMinor, 23000);
    assert.equal(move.debit.accountId, "34"); // clearing (destination)
    assert.equal(move.credit.accountId, "uf-1"); // Undeposited Funds (source)
    assert.equal(move.qboRefs.paymentId, "qpay-ol");
    assert.equal(move.autoEligible, true);
    assert.equal(byKind(proposals, "stripe_fee_expense")[0].amountMinor, 1075);
    assert.equal(byKind(proposals, "payout_transfer")[0].amountMinor, 33925);
    assert.ok(proposals.every((p) => p.autoEligible));
  });
});

describe("scenario: mixed DDB + suggested-only Ollie match", () => {
  // Same shape as above but the QBO payment carries no corroborating
  // identifier — a unique amount/date candidate only. The move is
  // proposed for human review and the aggregates stay manual, because
  // the payout is not fully identified.
  const { ledger, proposals } = run({
    txns: [sale("txn_d1", "ch_d1", 12000, 378), sale("txn_o1", "ch_o1", 23000, 697)],
    ddbRecords: [{ paymentId: "pay_d1", chargeId: "ch_d1" }],
    receipts: [["pay_d1", "synced"]],
    ollieCandidates: [
      olliePayment({ id: "qpay-ol", totalMinor: 23000, refNumber: "9000042" }),
    ],
  });

  it("suggests the move but keeps every proposal manual", () => {
    const line = ledger.lines.find((l) => l.txnId === "txn_o1")!;
    assert.equal(line.confidence, "suggested");
    assert.equal(proposals.length, 3);
    assert.ok(proposals.every((p) => !p.autoEligible));
    const move = byKind(proposals, "move_payment_to_clearing")[0];
    assert.equal(move.status, "proposed"); // human decides
  });
});

describe("scenario: multiple same-amount Ollie payments", () => {
  it("one Spreedly-verified candidate disambiguates the rest", () => {
    const { ledger, proposals } = run({
      txns: [sale("txn_o1", "ch_o1", 23000, 697)],
      chargeFacts: [
        [
          "ch_o1",
          {
            ollieIdentity: ollieIdentityFromChargeFacts({
              metadata: {
                connect_agent: "Spreedly",
                order_id: "00326-1623638",
              },
            }),
          },
        ],
      ],
      ollieCandidates: [
        olliePayment({ id: "q1", totalMinor: 23000, refNumber: "9000001" }),
        olliePayment({ id: "q2", totalMinor: 23000, refNumber: "9000002" }),
        olliePayment({
          id: "q3",
          totalMinor: 23000,
          refNumber: "1623638",
          linkedTxnIds: ["inv-326"],
          linkedDocNumbers: ["00326"],
        }),
      ],
    });
    const move = byKind(proposals, "move_payment_to_clearing")[0];
    assert.equal(move.qboRefs.paymentId, "q3");
    assert.equal(move.autoEligible, true);
    assert.equal(
      ledger.lines.find((l) => l.txnId === "txn_o1")!.confidence,
      "verified"
    );
  });

  it("no identity evidence → ambiguous, no proposal, manual aggregates", () => {
    const { ledger, proposals } = run({
      txns: [sale("txn_o1", "ch_o1", 23000, 697)],
      ollieCandidates: [
        olliePayment({ id: "q1", totalMinor: 23000 }),
        olliePayment({ id: "q2", totalMinor: 23000 }),
      ],
    });
    const line = ledger.lines.find((l) => l.txnId === "txn_o1")!;
    assert.equal(line.lane, "external");
    assert.equal(line.confidence, "ambiguous");
    assert.ok(ledger.exceptions.some((e) => e.code === "ambiguous_match"));
    assert.equal(byKind(proposals, "move_payment_to_clearing").length, 0);
    // Aggregates stay manual — the payout is not fully identified.
    assert.ok(proposals.every((p) => !p.autoEligible));
  });
});

describe("scenario: payout containing a refund", () => {
  // A charge + a refund in the same payout. Refunds are never
  // reclassified through Ollie payments; the line is flagged as an
  // exception and the aggregates stay manual — a human books the
  // reversal (#180 is the deferred auto-posting work).
  const { ledger, proposals } = run({
    txns: [
      sale("txn_d1", "ch_d1", 12000, 378),
      {
        txnId: "txn_r1",
        type: "refund",
        grossMinor: -4000,
        feeMinor: 0,
        netMinor: -4000,
        currency: "USD",
        sourceId: "re_1",
        createdMs: NOW - 3 * DAY_MS,
      },
    ],
    ddbRecords: [{ paymentId: "pay_d1", chargeId: "ch_d1" }],
    receipts: [["pay_d1", "synced"]],
  });

  it("flags the refund as an unmatched exception, aggregates manual", () => {
    assert.equal(ledger.totals.balanced, true);
    assert.equal(ledger.totals.computedNetMinor, 7622);
    const line = ledger.lines.find((l) => l.txnId === "txn_r1")!;
    assert.equal(line.lane, "external");
    assert.ok(
      ledger.exceptions.some(
        (e) => e.code === "unmatched_movement" && e.ref === "txn_r1"
      )
    );
    assert.ok(proposals.every((p) => !p.autoEligible));
  });
});

describe("scenario: unmatched external charge", () => {
  // A charge that is neither a DDB payment nor any UF payment — the
  // ledger cannot prove who it belongs to, so nothing posts unattended.
  const { ledger, proposals } = run({
    txns: [sale("txn_x1", "ch_x1", 5000, 175)],
  });
  it("flags unmatched_movement and keeps aggregates manual", () => {
    const line = ledger.lines[0];
    assert.equal(line.lane, "external");
    assert.equal(line.confidence, "unmatched");
    assert.ok(ledger.exceptions.some((e) => e.code === "unmatched_movement"));
    assert.ok(proposals.every((p) => !p.autoEligible));
  });
});

describe("scenario: foreign-currency movement", () => {
  // A EUR-denominated line inside a USD payout — excluded from every
  // total, flagged, and it prevents aggregate auto-eligibility because
  // the ledger is not a consistent picture.
  const { ledger, proposals } = run({
    txns: [
      sale("txn_d1", "ch_d1", 12000, 378),
      sale("txn_eur", "ch_eur", 3000, 90, { currency: "EUR" }),
    ],
    ddbRecords: [{ paymentId: "pay_d1", chargeId: "ch_d1" }],
    receipts: [["pay_d1", "synced"]],
  });
  it("excludes the foreign line, flags it, stays manual", () => {
    const line = ledger.lines.find((l) => l.txnId === "txn_eur")!;
    assert.equal(line.scope, "foreign_currency");
    assert.equal(ledger.totals.currencyConsistent, false);
    assert.ok(ledger.exceptions.some((e) => e.code === "foreign_currency"));
    assert.ok(proposals.every((p) => !p.autoEligible));
  });
});

describe("scenario: truncated / unbalanced ledger", () => {
  // The balance-transaction fetch was truncated — the ledger is a
  // partial picture. Aggregates must never run unattended on it.
  const { proposals } = run({
    txns: [sale("txn_d1", "ch_d1", 12000, 378)],
    ddbRecords: [{ paymentId: "pay_d1", chargeId: "ch_d1" }],
    receipts: [["pay_d1", "synced"]],
    ledgerComplete: false,
  });
  it("proposes the entries but marks aggregates not auto-eligible", () => {
    assert.equal(byKind(proposals, "stripe_fee_expense")[0].autoEligible, false);
    assert.equal(byKind(proposals, "payout_transfer")[0].autoEligible, false);
  });
});

describe("scenario: owner-entered manual entries already cover the posting", () => {
  // The owner historically posted fee journals and payout transfers by
  // hand. When a matching entry is detected, the proposal is suppressed
  // rather than double-posted — and the orchestrator surfaces an
  // existing_manual_entry exception (asserted in stripe-payouts.test.ts).
  const { proposals } = run({
    txns: [sale("txn_d1", "ch_d1", 12000, 378)],
    ddbRecords: [{ paymentId: "pay_d1", chargeId: "ch_d1" }],
    receipts: [["pay_d1", "synced"]],
    existingCover: { hasFeeEntry: true, hasTransferEntry: true },
  });
  it("suppresses both aggregates — no double-posting", () => {
    assert.equal(proposals.length, 0);
  });
});

describe("scenario: non-paid payout statuses", () => {
  for (const status of ["in_transit", "failed", "canceled", "pending"]) {
    it(`payout.${status} produces no proposals`, () => {
      const { proposals } = run({
        txns: [],
        payout: payout({ status, amountMinor: 19360 }),
      });
      assert.equal(proposals.length, 0);
    });
  }
});

describe("scenario: $50 Stripe minimum-balance reserve movements", () => {
  // The owner keeps a $50 minimum Stripe balance. Every payout carries a
  // `payout_minimum_balance_hold` (money into the reserve) and a
  // `payout_minimum_balance_release` (reserve released back) — observed on
  // every production payout. They are intra-Stripe account-level
  // movements: never revenue, fees, refunds, or bank transfers, and they
  // must not block an otherwise fully-identified payout from posting
  // unattended.
  const reserveLines: StripePayoutTxn[] = [
    charge({ txnId: "txn_payout_self", type: "payout" }),
    charge({
      txnId: "txn_hold",
      type: "payout_minimum_balance_hold",
      grossMinor: -5000,
      netMinor: -5000,
    }),
    charge({
      txnId: "txn_release",
      type: "payout_minimum_balance_release",
      grossMinor: 5000,
      netMinor: 5000,
    }),
  ];

  it("stay in the net so the ledger balances, and are account-level", () => {
    const { ledger } = run({
      txns: [
        sale("txn_d1", "ch_d1", 12000, 378),
        ...reserveLines,
      ],
      ddbRecords: [{ paymentId: "pay_d1", chargeId: "ch_d1" }],
      receipts: [["pay_d1", "synced"]],
    });
    assert.equal(ledger.totals.balanced, true);
    const hold = ledger.lines.find((l) => l.type === "payout_minimum_balance_hold");
    const release = ledger.lines.find((l) => l.type === "payout_minimum_balance_release");
    assert.equal(hold?.lane, "account_level");
    assert.equal(release?.lane, "account_level");
    // Never classified as revenue, fees, or refunds.
    assert.equal(ledger.totals.grossChargesMinor, 12000);
    assert.equal(ledger.totals.refundsMinor, 0);
    assert.equal(ledger.totals.feesMinor, 378);
  });

  it("do not block aggregates — a fully-identified payout with reserve movements is auto-eligible", () => {
    const { proposals } = run({
      txns: [
        sale("txn_d1", "ch_d1", 12000, 378),
        ...reserveLines,
      ],
      ddbRecords: [{ paymentId: "pay_d1", chargeId: "ch_d1" }],
      receipts: [["pay_d1", "synced"]],
    });
    // Payout amount = 12000 - 378 - 5000 + 5000 = 11622.
    const transfer = byKind(proposals, "payout_transfer")[0];
    assert.equal(transfer.amountMinor, 11622);
    assert.equal(transfer.autoEligible, true);
    assert.equal(byKind(proposals, "stripe_fee_expense")[0].autoEligible, true);
    assert.equal(byKind(proposals, "move_payment_to_clearing").length, 0);
  });

  it("a payout made only of reserve movements produces no auto-eligible work", () => {
    // $0 payout whose entire content is the reserve shuffle — nothing to
    // post, nothing to auto-execute.
    const { proposals } = run({ txns: [...reserveLines] });
    assert.ok(proposals.every((p) => !p.autoEligible));
  });

  it("an unrecognized account-level movement still blocks automation", () => {
    const { proposals } = run({
      txns: [
        sale("txn_d1", "ch_d1", 12000, 378),
        ...reserveLines,
        charge({ txnId: "txn_adj", type: "adjustment", grossMinor: -200, netMinor: -200 }),
      ],
      ddbRecords: [{ paymentId: "pay_d1", chargeId: "ch_d1" }],
      receipts: [["pay_d1", "synced"]],
    });
    assert.equal(byKind(proposals, "payout_transfer")[0].autoEligible, false);
    assert.equal(byKind(proposals, "stripe_fee_expense")[0].autoEligible, false);
  });
});
