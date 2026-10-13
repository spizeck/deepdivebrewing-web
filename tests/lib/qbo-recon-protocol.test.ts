import { describe, it } from "node:test";
import assert from "node:assert";
import {
  canonicalizeQboAccountBalance,
  canonicalizeQboReconActivity,
  qboAccountBalanceQuery,
  qboQueryResponseRowCount,
  qboReconActivityQuery,
} from "@/lib/qbo-protocol";

// Canonicalizer coverage for the issue #181 reconciliation reads: safe
// reduction of provider responses, minor-unit conversion, leg signing,
// and injection-safe query construction. Everything unexpected drops.

describe("qboAccountBalanceQuery / canonicalizeQboAccountBalance", () => {
  it("builds a quoted id query and refuses quote injection", () => {
    const stmt = qboAccountBalanceQuery("acct-123");
    assert.ok(stmt.includes("Id = 'acct-123'"));
    assert.ok(!qboAccountBalanceQuery("a'b").includes("a'b"));
  });

  it("reduces an account row to id/name/signed minor-unit balance", () => {
    const balance = canonicalizeQboAccountBalance({
      QueryResponse: {
        Account: [
          {
            Id: "94",
            Name: "Stripe Balance",
            AccountType: "Other Current Asset",
            CurrentBalance: 123.45,
            CurrencyRef: { value: "USD" },
          },
        ],
      },
    });
    assert.deepStrictEqual(balance, {
      id: "94",
      name: "Stripe Balance",
      accountType: "Other Current Asset",
      balanceMinor: 12345,
      currency: "USD",
    });
  });

  it("returns null for missing or malformed rows", () => {
    assert.strictEqual(canonicalizeQboAccountBalance({}), null);
    assert.strictEqual(
      canonicalizeQboAccountBalance({ QueryResponse: {} }),
      null
    );
    assert.strictEqual(
      canonicalizeQboAccountBalance({
        QueryResponse: { Account: [{ Id: "1" }] },
      }),
      null
    );
  });
});

describe("qboReconActivityQuery / qboQueryResponseRowCount", () => {
  it("bounds the window, paginates, and rejects non-date input", () => {
    const stmt = qboReconActivityQuery(
      "JournalEntry",
      "2026-05-01",
      "2026-05-31",
      1,
      100
    );
    assert.ok(stmt.includes("from JournalEntry"));
    assert.ok(stmt.includes("TxnDate >= '2026-05-01'"));
    assert.ok(stmt.includes("TxnDate <= '2026-05-31'"));
    assert.ok(stmt.includes("startposition 1 maxresults 100"));
    const injected = qboReconActivityQuery(
      "Purchase",
      "2026-05-01' or '1'='1",
      "2026-05-31"
    );
    assert.ok(injected.includes("TxnDate >= '1970-01-01'"));
  });

  it("counts raw response rows per entity key", () => {
    const payload = { QueryResponse: { Transfer: [{}, {}] } };
    assert.strictEqual(qboQueryResponseRowCount("Transfer", payload), 2);
    assert.strictEqual(qboQueryResponseRowCount("Deposit", payload), 0);
  });
});

describe("canonicalizeQboReconActivity", () => {
  it("signs JournalEntry legs by posting type", () => {
    const rows = canonicalizeQboReconActivity("JournalEntry", {
      QueryResponse: {
        JournalEntry: [
          {
            Id: "7",
            TxnDate: "2026-05-10",
            DocNumber: "JE-12",
            Line: [
              {
                Amount: 25.0,
                JournalEntryLineDetail: {
                  PostingType: "Debit",
                  AccountRef: { value: "94" },
                },
              },
              {
                Amount: 25.0,
                JournalEntryLineDetail: {
                  PostingType: "Credit",
                  AccountRef: { value: "35" },
                },
              },
            ],
          },
        ],
      },
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, "7");
    assert.strictEqual(rows[0].docNumber, "JE-12");
    assert.deepStrictEqual(rows[0].legs, [
      { accountId: "94", amountMinor: 2500 },
      { accountId: "35", amountMinor: -2500 },
    ]);
  });

  it("reads Purchase expense legs and always emits the payment-account leg", () => {
    // Detail lines debit the expense accounts; the header AccountRef is
    // the paying account and is credited −TotalAmt — emitted even when
    // lines exist, since the watched clearing account sits there.
    const withLines = canonicalizeQboReconActivity("Purchase", {
      QueryResponse: {
        Purchase: [
          {
            Id: "11",
            TxnDate: "2026-05-12",
            AccountRef: { value: "94" },
            TotalAmt: 4.2,
            Line: [
              {
                Amount: 4.2,
                AccountBasedExpenseLineDetail: {
                  AccountRef: { value: "77" },
                },
              },
            ],
          },
        ],
      },
    });
    assert.deepStrictEqual(withLines[0].legs, [
      { accountId: "77", amountMinor: 420 },
      { accountId: "94", amountMinor: -420 },
    ]);

    const sparse = canonicalizeQboReconActivity("Purchase", {
      QueryResponse: {
        Purchase: [
          { Id: "12", TxnDate: "2026-05-13", AccountRef: { value: "55" }, TotalAmt: 9.99 },
        ],
      },
    });
    assert.deepStrictEqual(sparse[0].legs, [
      { accountId: "55", amountMinor: -999 },
    ]);
  });

  it("inverts Purchase legs for a vendor credit", () => {
    const rows = canonicalizeQboReconActivity("Purchase", {
      QueryResponse: {
        Purchase: [
          {
            Id: "13",
            TxnDate: "2026-05-14",
            Credit: true,
            AccountRef: { value: "94" },
            TotalAmt: 10.0,
            Line: [
              {
                Amount: 10.0,
                AccountBasedExpenseLineDetail: {
                  AccountRef: { value: "77" },
                },
              },
            ],
          },
        ],
      },
    });
    assert.deepStrictEqual(rows[0].legs, [
      { accountId: "77", amountMinor: -1000 },
      { accountId: "94", amountMinor: 1000 },
    ]);
  });

  it("credits Deposit source lines and always emits the destination leg", () => {
    const rows = canonicalizeQboReconActivity("Deposit", {
      QueryResponse: {
        Deposit: [
          {
            Id: "21",
            TxnDate: "2026-05-15",
            DepositToAccountRef: { value: "12" },
            TotalAmt: 100.0,
            Line: [
              {
                Amount: 100.0,
                DepositLineDetail: { AccountRef: { value: "94" } },
              },
            ],
          },
          { Id: "22", TxnDate: "2026-05-16", DepositToAccountRef: { value: "12" }, TotalAmt: 250.0 },
        ],
      },
    });
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows[0].legs, [
      { accountId: "94", amountMinor: -10000 },
      { accountId: "12", amountMinor: 10000 },
    ]);
    assert.deepStrictEqual(rows[1].legs, [
      { accountId: "12", amountMinor: 25000 },
    ]);
  });

  it("emits signed legs for a Transfer", () => {
    const rows = canonicalizeQboReconActivity("Transfer", {
      QueryResponse: {
        Transfer: [
          {
            Id: "31",
            TxnDate: "2026-05-20",
            Amount: 500.0,
            FromAccountRef: { value: "94" },
            ToAccountRef: { value: "12" },
          },
        ],
      },
    });
    assert.deepStrictEqual(rows[0].legs, [
      { accountId: "94", amountMinor: -50000 },
      { accountId: "12", amountMinor: 50000 },
    ]);
  });

  it("drops malformed rows and rows without attributable legs", () => {
    const rows = canonicalizeQboReconActivity("JournalEntry", {
      QueryResponse: {
        JournalEntry: [
          "not-an-object",
          { Id: "1", Line: [] },
          {
            Id: "2",
            Line: [{ Amount: 5.0, JournalEntryLineDetail: {} }],
          },
          {
            Id: "3",
            TxnDate: "2026-05-01",
            Line: [
              {
                Amount: 5.0,
                JournalEntryLineDetail: {
                  PostingType: "Debit",
                  AccountRef: { value: "94" },
                },
              },
            ],
          },
        ],
      },
    });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, "3");
  });
});
