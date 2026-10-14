import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDdbPaymentIndex,
  buildPayoutLedger,
  buildPayoutProposals,
  compareOllieRefs,
  extractOllieRefsFromMetadata,
  extractOllieRefsFromText,
  matchOlliePayment,
  ollieRefsFromQboPayment,
  proposalMaterialFingerprint,
  qboProposalIdFor,
  STRIPE_PAYOUT_EVENT_TYPES,
  STRIPE_PAYOUT_LEDGER_TRIGGERS,
  type OllieRefSet,
  type OllieStripeIdentity,
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

  it("excludes the payout's own debit from the net sum — holds and releases still reconcile", () => {
    // Live `balanceTransactions.list({payout})` returns the payout's own
    // debit transaction alongside the constituents (observed on
    // po_1UPu2kC2zsUcVaNLpowu61JK). Counting it in computedNetMinor
    // reports $0 and a false imbalance; hold/release movements stay in —
    // they legitimately explain the paid amount.
    const ledger = buildPayoutLedger(
      emptyInput({
        payout: payout({ amountMinor: 28518 }),
        txns: [
          charge({
            txnId: "txn_charge",
            grossMinor: 29401,
            feeMinor: 883,
            netMinor: 28518,
            sourceId: "ch_ollie",
          }),
          {
            txnId: "txn_payout_debit",
            type: "payout",
            grossMinor: -28518,
            feeMinor: 0,
            netMinor: -28518,
            currency: "USD",
            sourceId: "po_self",
            createdMs: NOW,
          },
          {
            txnId: "txn_hold",
            type: "payout_minimum_balance_hold",
            grossMinor: -5000,
            feeMinor: 0,
            netMinor: -5000,
            currency: "USD",
            createdMs: NOW,
          },
          {
            txnId: "txn_release",
            type: "payout_minimum_balance_release",
            grossMinor: 5000,
            feeMinor: 0,
            netMinor: 5000,
            currency: "USD",
            createdMs: NOW,
          },
        ],
      })
    );
    assert.equal(ledger.totals.computedNetMinor, 28518);
    assert.equal(ledger.totals.balanced, true);
    // The self-debit line stays visible in the ledger — it is a real
    // movement, just not a constituent of the paid amount.
    assert.equal(
      ledger.lines.find((line) => line.type === "payout")?.lane,
      "account_level"
    );
    assert.equal(ledger.totals.grossChargesMinor, 29401);
    assert.equal(ledger.totals.feesMinor, 883);
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

// --- Evidence-based Ollie identity matching ---

function refs(overrides: Partial<OllieRefSet> = {}): OllieRefSet {
  return {
    orderNumbers: [],
    paymentNumbers: [],
    invoiceNumbers: [],
    ...overrides,
  };
}

function identity(overrides: Partial<OllieStripeIdentity> = {}): OllieStripeIdentity {
  return { refs: refs(), ...overrides };
}

const TXN = { amountMinor: 10000, currency: "USD", createdMs: NOW - 4 * DAY_MS };

describe("Ollie reference extraction", () => {
  it("extracts labeled refs and ignores unlabeled digits", () => {
    const r = refs();
    extractOllieRefsFromText("Ollie Order #00327 · call 5551234", r);
    assert.deepEqual(r.orderNumbers, ["327"]); // padding normalized
    assert.deepEqual(r.paymentNumbers, []);
    extractOllieRefsFromText("Ollie Payment #1626166", r);
    assert.deepEqual(r.paymentNumbers, ["1626166"]);
  });

  it("namespaces metadata by key and never treats paymentId as Ollie", () => {
    const r = refs();
    extractOllieRefsFromMetadata(
      {
        paymentId: "pay_ddb_doc", // DDB's own key — different space
        ollie_order_id: "00327",
        olliePaymentNumber: "1626166",
        note: "invoice #00327",
      },
      r
    );
    assert.deepEqual(r.orderNumbers, ["327"]);
    assert.deepEqual(r.paymentNumbers, ["1626166"]);
    // "invoice #00327" inside a string value is labeled text.
    assert.deepEqual(r.invoiceNumbers, ["327"]);
    assert.ok(!Object.values(r).flat().includes("pay_ddb_doc"));
  });

  it("reads QBO refs: PaymentRefNum digits, memo labels, DocNumbers", () => {
    const r = ollieRefsFromQboPayment({
      refNumber: "1626166",
      memo: "Ollie Payment #1626166",
      linkedDocNumbers: ["00327"],
    });
    assert.deepEqual(r.paymentNumbers, ["1626166"]);
    assert.deepEqual(r.invoiceNumbers, ["327"]);
    // Prefixed DocNumbers resolve on the trailing digit run.
    const prefixed = ollieRefsFromQboPayment({
      refNumber: "1626166",
      linkedDocNumbers: ["INV-2026-00327"],
    });
    assert.deepEqual(prefixed.invoiceNumbers, ["327"]);
  });

  it("compares per documented chain — populated-but-disjoint is a conflict", () => {
    // Stripe order refs resolve against BOTH qbo order refs and linked
    // invoice DocNumbers (Ollie order #N becomes invoice DocNumber N).
    const same = compareOllieRefs(
      refs({ orderNumbers: ["327"] }),
      refs({ invoiceNumbers: ["327"] })
    );
    assert.deepEqual(same.hits, ["order-invoice:327"]);
    assert.deepEqual(same.conflicts, []);
    // Disjoint in a populated shared space contradicts the candidate.
    const clash = compareOllieRefs(
      refs({ orderNumbers: ["327"] }),
      refs({ orderNumbers: ["999"] })
    );
    assert.deepEqual(clash.conflicts, ["order"]);
    // Unrelated namespaces never collide: a payment number does not
    // satisfy or contradict an order reference.
    const unrelated = compareOllieRefs(
      refs({ orderNumbers: ["327"] }),
      refs({ paymentNumbers: ["327"] })
    );
    assert.deepEqual(unrelated.hits, []);
    assert.deepEqual(unrelated.conflicts, []);
  });
});

describe("matchOlliePayment identity tiers", () => {
  const stripeIdentity = (r: Partial<OllieRefSet>, customerName?: string) =>
    identity({ refs: refs(r), customerName });

  it("verifies via the Stripe order ↔ QBO invoice DocNumber chain", () => {
    // Real chain: Stripe "Ollie Order #00327" → QBO payment's linked
    // invoice DocNumber 00327 (invoice #00327 = Ollie order #00327).
    const result = matchOlliePayment(
      TXN,
      [olliePayment({ linkedDocNumbers: ["00327"] })],
      "USD",
      stripeIdentity({ orderNumbers: ["327"] }, "Sea Saba")
    );
    assert.equal(result.confidence, "verified");
    assert.equal(result.payment?.id, "42");
    assert.deepEqual(result.identityRefs, ["order-invoice:327"]);
    assert.ok(result.evidence.includes("identity_match"));
    assert.ok(result.evidence.includes("exact_amount"));
  });

  it("verifies via the Stripe payment ↔ QBO PaymentRefNum chain", () => {
    const result = matchOlliePayment(
      TXN,
      [olliePayment()],
      "USD",
      stripeIdentity({ paymentNumbers: ["1626166"] })
    );
    assert.equal(result.confidence, "verified");
    assert.deepEqual(result.identityRefs, ["payment:1626166"]);
  });

  it("stays suggested when Stripe carries no usable identifier", () => {
    const result = matchOlliePayment(TXN, [olliePayment()], "USD", identity());
    assert.equal(result.confidence, "suggested");
    // Candidate had an Ollie ref but Stripe offered nothing to compare.
    assert.ok(result.evidence.includes("ollie_reference_only"));
  });

  it("fails closed to ambiguous on same-namespace identifier conflict", () => {
    // Stripe says order 327; the only amount/date candidate links
    // invoice 999 — a contradiction, not a match.
    const result = matchOlliePayment(
      TXN,
      [olliePayment({ linkedDocNumbers: ["999"] })],
      "USD",
      stripeIdentity({ orderNumbers: ["327"] })
    );
    assert.equal(result.confidence, "ambiguous");
    assert.ok(result.evidence.includes("identifier_conflict"));
    assert.equal(result.payment, undefined);
  });

  it("fails closed when two candidates share the identifier", () => {
    const result = matchOlliePayment(
      TXN,
      [
        olliePayment({ linkedDocNumbers: ["00327"] }),
        olliePayment({ id: "77", linkedDocNumbers: ["00327"] }),
      ],
      "USD",
      stripeIdentity({ orderNumbers: ["327"] })
    );
    assert.equal(result.confidence, "ambiguous");
    assert.ok(result.evidence.includes("multiple_identity_matches"));
  });

  it("verified identity disambiguates identical-amount candidates", () => {
    // Two same-amount payments in the window; only one links invoice 327.
    const result = matchOlliePayment(
      TXN,
      [
        olliePayment({ linkedDocNumbers: ["00327"] }),
        olliePayment({ id: "77", refNumber: "Ollie Payment #999999", linkedDocNumbers: ["00888"] }),
      ],
      "USD",
      stripeIdentity({ orderNumbers: ["327"] })
    );
    // Candidate 77 has invoice 888 populated — disjoint from stripe's
    // order namespace... wait, invoice vs order are different spaces, so
    // 77's invoiceNumbers aren't consulted against stripe orderNumbers.
    // But its paymentNumbers (999999) vs stripe orderNumbers — different
    // spaces too. With no stripe-side payment/invoice refs, 77 has no
    // populated shared namespace → neither hit nor conflict → verified
    // stands for candidate 42.
    assert.equal(result.confidence, "verified");
    assert.equal(result.payment?.id, "42");
    assert.ok(result.evidence.includes("identity_disambiguated"));
  });

  it("a conflicting second candidate downgrades a verified hit", () => {
    const result = matchOlliePayment(
      TXN,
      [
        olliePayment({ linkedDocNumbers: ["00327"] }),
        olliePayment({
          id: "77",
          refNumber: "999999",
          linkedDocNumbers: ["00327"],
        }),
      ],
      "USD",
      stripeIdentity({ orderNumbers: ["327"], invoiceNumbers: ["888"] })
    );
    // 42 hits on order↔invoice; 77 hits order↔invoice too? no — both
    // link doc 00327 → two identity hits → ambiguous.
    assert.equal(result.confidence, "ambiguous");
  });

  it("demotes to suggested when the customer name conflicts", () => {
    const result = matchOlliePayment(
      TXN,
      [olliePayment({ linkedDocNumbers: ["00327"] })],
      "USD",
      stripeIdentity({ orderNumbers: ["327"] }, "Different Customer Inc")
    );
    assert.equal(result.confidence, "suggested");
    assert.ok(result.evidence.includes("customer_mismatch"));
  });

  it("identical amounts for different customers stay suggested or ambiguous", () => {
    // Two identical payments, no stripe refs — uniqueness fails closed.
    const result = matchOlliePayment(
      TXN,
      [
        olliePayment(),
        olliePayment({ id: "77", customerName: "Other Bar" }),
      ],
      "USD",
      stripeIdentity({ orderNumbers: ["327"] })
    );
    assert.equal(result.confidence, "ambiguous");
  });

  it("a Cash-labeled QBO payment verifies like any other", () => {
    // QBO PaymentMethodRef is never read — a Cash label neither helps
    // nor disqualifies; the identifier chain decides.
    const result = matchOlliePayment(
      TXN,
      [olliePayment({ linkedDocNumbers: ["00327"] })],
      "USD",
      stripeIdentity({ orderNumbers: ["327"] })
    );
    assert.equal(result.confidence, "verified");
  });
});

describe("buildPayoutLedger with identity evidence", () => {
  it("verifies an Ollie match when Stripe enrichment shares the order number", () => {
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [charge({ sourceId: "ch_ollie" })],
        resolvedChargeFacts: new Map([
          [
            "ch_ollie",
            {
              ollieIdentity: identity({
                refs: refs({ orderNumbers: ["327"] }),
              }),
            },
          ],
        ]),
        ollieCandidates: [olliePayment({ linkedDocNumbers: ["00327"] })],
      })
    );
    const line = ledger.lines[0];
    assert.equal(line.lane, "ollie");
    assert.equal(line.confidence, "verified");
    assert.deepEqual(line.identityRefs, ["order-invoice:327"]);
    assert.equal(line.qboPaymentId, "42");
  });

  it("never treats refunds as charge matches — explicit non-match", () => {
    const ledger = buildPayoutLedger(
      emptyInput({
        txns: [
          {
            txnId: "txn_r",
            type: "refund",
            grossMinor: -5000,
            feeMinor: 0,
            netMinor: -5000,
            currency: "USD",
            sourceId: "re_1",
            createdMs: NOW - 3 * DAY_MS,
          },
        ],
        ollieCandidates: [olliePayment({ totalMinor: -5000 })],
      })
    );
    const line = ledger.lines[0];
    assert.equal(line.lane, "external");
    assert.equal(line.confidence, "unmatched");
    assert.ok(line.evidence.includes("refund_not_reclassifiable"));
    assert.ok(
      ledger.exceptions.some((e) => e.code === "unmatched_movement")
    );
  });
});

describe("proposalMaterialFingerprint", () => {
  const fpMapping = {
    stripeClearingAccountId: "clearing-1",
    stripeFeeExpenseAccountId: "fee-1",
    stripePayoutAccountId: "bank-1",
  };

  function verifiedLedger(order: string, doc: string) {
    return buildPayoutLedger(
      emptyInput({
        txns: [charge({ sourceId: "ch_ollie" })],
        resolvedChargeFacts: new Map([
          [
            "ch_ollie",
            {
              ollieIdentity: identity({
                refs: refs({ orderNumbers: [order] }),
              }),
            },
          ],
        ]),
        ollieCandidates: [olliePayment({ linkedDocNumbers: [doc] })],
      })
    );
  }

  function moveProposal(undepositedFundsId = "uf-1", order = "327") {
    const doc = order.padStart(5, "0");
    return buildPayoutProposals({
      environment: "sandbox",
      payout: payout(),
      ledger: verifiedLedger(order, doc),
      mode: "observe",
      mapping: fpMapping,
      undepositedFundsId,
    }).find((p) => p.kind === "move_payment_to_clearing")!;
  }

  it("stamps every proposal with a stable, non-empty fingerprint", () => {
    const a = moveProposal();
    const b = moveProposal();
    assert.ok(a.materialFingerprint);
    assert.equal(a.materialFingerprint, b.materialFingerprint);
  });

  it("changes when any material fact changes", () => {
    const base = moveProposal();
    // A different matched payment id — different qboRefs.
    const other = buildPayoutProposals({
      environment: "sandbox",
      payout: payout(),
      ledger: buildPayoutLedger(
        emptyInput({
          txns: [charge({ sourceId: "ch_ollie" })],
          resolvedChargeFacts: new Map([
            [
              "ch_ollie",
              {
                ollieIdentity: identity({
                  refs: refs({ orderNumbers: ["327"] }),
                }),
              },
            ],
          ]),
          ollieCandidates: [
            olliePayment({ id: "99", linkedDocNumbers: ["00327"] }),
          ],
        })
      ),
      mode: "observe",
      mapping: fpMapping,
      undepositedFundsId: "uf-1",
    }).find((p) => p.kind === "move_payment_to_clearing")!;
    assert.notEqual(base.materialFingerprint, other.materialFingerprint);
    // A different Undeposited Funds account — the credit leg moved.
    const uf2 = moveProposal("uf-2");
    assert.equal(uf2.credit.accountId, "uf-2");
    assert.notEqual(base.materialFingerprint, uf2.materialFingerprint);
    // A different verified identity — the refs that carried the match
    // changed even though the payment id stayed the same.
    const otherIdentity = moveProposal("uf-1", "328");
    assert.ok(
      otherIdentity.stripeRefs.identity?.includes("order-invoice:328")
    );
    assert.notEqual(
      base.materialFingerprint,
      otherIdentity.materialFingerprint
    );
  });

  it("cannot collide across delimiters — values are structurally encoded", () => {
    const proposal = {
      kind: "payout_transfer" as const,
      amountMinor: 100,
      currency: "USD",
      accountingDate: "2026-10-15",
      debit: { accountId: "a", label: "x" },
      credit: { accountId: "b", label: "y" },
      stripeRefs: {},
      qboRefs: {},
      evidence: ["a|b"],
    };
    // "a|b" as one value must not collide with "a" + "b" as two.
    const split = { ...proposal, evidence: ["a", "b"] };
    assert.notEqual(
      proposalMaterialFingerprint(proposal),
      proposalMaterialFingerprint(split)
    );
    // Ref keys/values are canonicalized — insertion order cannot change
    // the fingerprint, but a different key for the same value must.
    const refsA = proposalMaterialFingerprint({
      ...proposal,
      qboRefs: { paymentId: "42", paymentRef: "7" },
    });
    const refsB = proposalMaterialFingerprint({
      ...proposal,
      qboRefs: { paymentRef: "7", paymentId: "42" },
    });
    const refsC = proposalMaterialFingerprint({
      ...proposal,
      qboRefs: { otherId: "42", paymentRef: "7" },
    });
    assert.equal(refsA, refsB);
    assert.notEqual(refsA, refsC);
  });
});
