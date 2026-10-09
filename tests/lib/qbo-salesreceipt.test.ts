import { describe, it } from "node:test";
import assert from "node:assert";
import {
  qboIncomeItemKeyForPurpose,
  qboSalesReceiptDocNumber,
  qboSalesReceiptMarker,
} from "@/lib/qbo-common";
import {
  buildQboSalesReceiptPayload,
  canonicalizeQboSalesReceiptCreated,
  canonicalizeQboSalesReceiptRefs,
  qboSalesReceiptCorrelationQuery,
  qboSalesReceiptRowCount,
} from "@/lib/qbo-protocol";
import { QboError } from "@/lib/qbo-errors";

const BASE_SPEC = {
  sourceId: "9f8e7d6c-1234-4abc-9def-0123456789ab",
  amountMinor: 500,
  currency: "USD",
  paidAtMs: Date.UTC(2026, 1, 5, 14, 30, 0),
  description: "Brewery tour",
  clearingAccountId: "42",
  incomeItemId: "7",
  customerId: "88",
  paymentMethodId: "pm-card",
  paymentIntentId: "pi_3abc",
  chargeId: "ch_3abc",
} as const;

describe("qboIncomeItemKeyForPurpose", () => {
  it("maps tour-family purposes to the tour income item", () => {
    for (const purpose of ["brewery_tour", "additional_guests", "private_tour"]) {
      assert.strictEqual(qboIncomeItemKeyForPurpose(purpose), "tourIncomeItemId");
    }
  });

  it("maps tasting and other purposes to their items", () => {
    assert.strictEqual(
      qboIncomeItemKeyForPurpose("brewery_tour_tasting"),
      "tastingIncomeItemId"
    );
    assert.strictEqual(qboIncomeItemKeyForPurpose("other"), "otherIncomeItemId");
  });

  it("fails closed on unknown or absent purposes", () => {
    assert.strictEqual(qboIncomeItemKeyForPurpose("merch"), null);
    assert.strictEqual(qboIncomeItemKeyForPurpose(""), null);
    assert.strictEqual(qboIncomeItemKeyForPurpose(undefined), null);
  });
});

describe("qboSalesReceiptMarker / DocNumber", () => {
  it("embeds the source id in a matchable marker", () => {
    assert.strictEqual(qboSalesReceiptMarker("pay-1"), "ddb:pay-1");
  });

  it("derives a deterministic DocNumber within QBO's 21-char limit", () => {
    const doc = qboSalesReceiptDocNumber(BASE_SPEC.sourceId);
    assert.ok(doc.startsWith("DDB-"));
    assert.ok(doc.length <= 21);
    assert.strictEqual(doc, qboSalesReceiptDocNumber(BASE_SPEC.sourceId));
    // Different source ids must not collide in the truncated suffix.
    assert.notStrictEqual(
      qboSalesReceiptDocNumber("aaaaaaaa-0000-0000-0000-000000000001"),
      qboSalesReceiptDocNumber("bbbbbbbb-0000-0000-0000-000000000002")
    );
  });
});

describe("buildQboSalesReceiptPayload", () => {
  it("posts the gross amount as decimal currency, never Stripe net", () => {
    const payload = buildQboSalesReceiptPayload({
      ...BASE_SPEC,
      amountMinor: 500,
    });
    const line = (payload.Line as Record<string, unknown>[])[0];
    assert.strictEqual(line.Amount, 5);
    const detail = line.SalesItemLineDetail as Record<string, unknown>;
    assert.strictEqual(detail.Qty, 1);
    assert.strictEqual(detail.UnitPrice, 5);
    // $5.00 gross — the $0.45 fee and $4.55 net are #181's concern and
    // must not appear anywhere in the payload.
    assert.strictEqual(JSON.stringify(payload).includes("4.55"), false);
  });

  it("handles non-round cent amounts without float drift beyond cents", () => {
    const payload = buildQboSalesReceiptPayload({
      ...BASE_SPEC,
      amountMinor: 1234,
    });
    assert.strictEqual(
      (payload.Line as Record<string, unknown>[])[0].Amount,
      12.34
    );
  });

  it("targets the mapped item, clearing account, customer, and currency", () => {
    const payload = buildQboSalesReceiptPayload(BASE_SPEC);
    assert.deepStrictEqual(payload.CustomerRef, { value: "88" });
    assert.deepStrictEqual(payload.DepositToAccountRef, { value: "42" });
    assert.deepStrictEqual(payload.CurrencyRef, { value: "USD" });
    // The rail is explicit on the receipt — the mapped QBO PaymentMethod,
    // never left blank or inferred from the deposit account.
    assert.deepStrictEqual(payload.PaymentMethodRef, { value: "pm-card" });
    const detail = (
      payload.Line as Record<string, unknown>[]
    )[0].SalesItemLineDetail as Record<string, unknown>;
    assert.deepStrictEqual(detail.ItemRef, { value: "7" });
    // Never the generic deposit targets — no bank, no Undeposited Funds
    // assumptions: the account id is exactly what was mapped.
  });

  it("dates the receipt at settlement (paidAt), not processing time", () => {
    const payload = buildQboSalesReceiptPayload(BASE_SPEC);
    assert.strictEqual(payload.TxnDate, "2026-02-05");
  });

  it("carries the correlation marker and provider refs in PrivateNote", () => {
    const payload = buildQboSalesReceiptPayload(BASE_SPEC);
    const note = payload.PrivateNote as string;
    assert.ok(note.includes(`ddb:${BASE_SPEC.sourceId}`));
    assert.ok(note.includes("pi_3abc"));
    assert.ok(note.includes("ch_3abc"));
    assert.strictEqual(payload.DocNumber, qboSalesReceiptDocNumber(BASE_SPEC.sourceId));
  });

  it("sends GlobalTaxCalculation only for non-US companies — no US tax semantics", () => {
    const nonUs = buildQboSalesReceiptPayload({
      ...BASE_SPEC,
      globalTaxCalculation: "NotApplicable",
    });
    assert.strictEqual(nonUs.GlobalTaxCalculation, "NotApplicable");
    const us = buildQboSalesReceiptPayload(BASE_SPEC);
    assert.ok(!("GlobalTaxCalculation" in us));
    // Tax posting is disabled entirely: no TaxCodeRef anywhere, regardless.
    assert.strictEqual(JSON.stringify(nonUs).includes("TaxCodeRef"), false);
    assert.strictEqual(JSON.stringify(us).includes("TaxCodeRef"), false);
  });

  it("truncates the line description and omits it when absent", () => {
    const long = buildQboSalesReceiptPayload({
      ...BASE_SPEC,
      description: "x".repeat(600),
    });
    assert.strictEqual(
      ((long.Line as Record<string, unknown>[])[0].Description as string)
        .length,
      500
    );
    const minimal = buildQboSalesReceiptPayload({
      ...BASE_SPEC,
      description: undefined,
    });
    assert.ok(!("Description" in (minimal.Line as Record<string, unknown>[])[0]));
  });
});

describe("canonicalizeQboSalesReceiptCreated", () => {
  it("extracts the provider entity id", () => {
    assert.deepStrictEqual(
      canonicalizeQboSalesReceiptCreated({ SalesReceipt: { Id: "917" } }),
      { id: "917" }
    );
    assert.deepStrictEqual(
      canonicalizeQboSalesReceiptCreated({ SalesReceipt: { Id: 42 } }),
      { id: "42" }
    );
  });

  it("rejects a malformed response without leaking payload", () => {
    assert.throws(
      () => canonicalizeQboSalesReceiptCreated({ SalesReceipt: {} }),
      (e) => e instanceof QboError && e.kind === "unexpected"
    );
    assert.throws(
      () => canonicalizeQboSalesReceiptCreated(null),
      (e) => e instanceof QboError
    );
  });
});

describe("sales receipt correlation lookup", () => {
  it("queries the customer's receipts on the settlement date, paginated", () => {
    const query = qboSalesReceiptCorrelationQuery(
      "cust'7",
      "2026-02-05",
      101,
      50
    );
    assert.ok(query.includes("SalesReceipt"));
    assert.ok(query.includes("CustomerRef = 'cust7'")); // sanitized id
    assert.ok(query.includes("PrivateNote"));
    // The TxnDate equality filter bounds the window to the payment's own
    // settlement date — a landed receipt always carries the posted
    // TxnDate (paidAt), no matter how many receipts the customer has.
    assert.ok(query.includes("TxnDate = '2026-02-05'"));
    assert.ok(query.includes("startposition 101"));
    assert.ok(query.includes("maxresults 50"));
    // TxnDate is the documented sortable field — MetaData.CreateTime is
    // not, so the recovery window orders by it.
    assert.ok(query.includes("orderby TxnDate"));
  });

  it("rejects a malformed transaction date rather than building a bad query", () => {
    assert.throws(
      () => qboSalesReceiptCorrelationQuery("cust-1", "02/05/2026"),
      (e) => e instanceof QboError
    );
    assert.throws(
      () => qboSalesReceiptCorrelationQuery("cust-1", "2026-02-05' OR '1'='1"),
      (e) => e instanceof QboError
    );
  });

  it("counts raw SalesReceipt rows for the pagination signal", () => {
    assert.strictEqual(
      qboSalesReceiptRowCount({
        QueryResponse: { SalesReceipt: [{ Id: "1" }, { Id: "2" }] },
      }),
      2
    );
    assert.strictEqual(qboSalesReceiptRowCount({ QueryResponse: {} }), 0);
    assert.strictEqual(qboSalesReceiptRowCount(null), 0);
  });

  it("canonicalizes id + privateNote refs for marker matching", () => {
    const refs = canonicalizeQboSalesReceiptRefs({
      QueryResponse: {
        SalesReceipt: [
          { Id: "1", PrivateNote: "Deep Dive Brewing payment ddb:pay-1; Stripe PI pi_1" },
          { Id: "2" },
          { PrivateNote: "no id — dropped" },
        ],
      },
    });
    assert.deepStrictEqual(refs, [
      {
        id: "1",
        privateNote: "Deep Dive Brewing payment ddb:pay-1; Stripe PI pi_1",
      },
      { id: "2", privateNote: undefined },
    ]);
    assert.deepStrictEqual(canonicalizeQboSalesReceiptRefs({}), []);
    assert.deepStrictEqual(canonicalizeQboSalesReceiptRefs(null), []);
  });
});
