import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";

// Regression coverage for the production failure Sentry reported as
// qbo.recon_run_failed: Firestore rejected `undefined` at
// view.qboLedgerItems.0.docNumber. These tests run the real
// runQboReconciliation orchestration with the provider and Firestore
// boundaries mocked, capture the exact payload handed to
// `qboReconState.<env>.set()`, and assert no undefined survives anywhere
// in it — while legitimately-present data round-trips back out through
// getQboReconLatest intact.

mock.module("server-only", { namedExports: {} });

const SERVER_TS = new (class ServerTimestampSentinel {})();

mock.module("firebase-admin/firestore", {
  namedExports: {
    FieldValue: { serverTimestamp: () => SERVER_TS },
    Timestamp: { fromMillis: (ms: number) => ({ ms }) },
  },
});

// --- Fake Firestore ---

interface FakeDoc {
  [key: string]: unknown;
}

let paymentDocs: { id: string; data: () => FakeDoc }[] = [];
let storedDoc: FakeDoc | undefined;
const setPayloads: FakeDoc[] = [];

const paymentsQuery = {
  where: () => paymentsQuery,
  limit: () => paymentsQuery,
  get: async () => ({ docs: paymentDocs, size: paymentDocs.length }),
};

const stateDocRef = {
  get: async () => ({ data: () => storedDoc }),
  set: async (payload: FakeDoc) => {
    setPayloads.push(payload);
  },
};

const fakeDb = {
  collection: (name: string) =>
    name === "payments"
      ? { where: () => paymentsQuery }
      : { doc: () => stateDocRef },
};

mock.module("@/lib/firebase-admin-db", {
  namedExports: { getFirebaseAdminDb: () => fakeDb },
});

// --- Provider boundaries ---

let qboConfigured = true;
// qbo-protocol (kept real) imports endpoint constants from qbo-config —
// the mock must supply the module's full surface, not just the flags.
mock.module("@/lib/qbo-config", {
  namedExports: {
    getQboEnvironment: () => "sandbox",
    isQboConfigured: () => qboConfigured,
    QBO_ACCOUNTING_SCOPE: "com.intuit.quickbooks.accounting",
    QBO_AUTHORIZE_URL: "https://appcenter.intuit.com/connect/oauth2",
    QBO_TOKEN_URL:
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    QBO_REVOKE_URL:
      "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
    QBO_MINOR_VERSION: "75",
    qboApiBaseUrl: (environment: string) =>
      environment === "production"
        ? "https://quickbooks.api.intuit.com"
        : "https://sandbox-quickbooks.api.intuit.com",
  },
});

const loggedErrors: string[] = [];
mock.module("@/lib/log", {
  namedExports: {
    logError: (event: string) => {
      loggedErrors.push(event);
    },
    logInfo: () => {},
    logWarn: () => {},
  },
});

mock.module("@/lib/qbo-tokens", {
  namedExports: {
    getQuickBooksAccessToken: async () => ({
      realmId: "9341454758987654",
      accessToken: "access-token",
    }),
  },
});

let mappingView: unknown = {
  mapping: { stripeClearingAccountId: "34", stripeFeeExpenseAccountId: "86" },
};
mock.module("@/lib/qbo-mapping", {
  namedExports: { getQboMappingView: async () => mappingView },
});

interface FakeAccount {
  id: string;
  name: string;
  balanceMinor: number;
  currency?: string;
}
const accountBalances = new Map<string, FakeAccount>();
let activityRows: {
  entityType: string;
  id: string;
  txnDate?: string;
  docNumber?: string;
  memo?: string;
  legs: { accountId: string; amountMinor: number }[];
}[] = [];

mock.module("@/lib/qbo-api", {
  namedExports: {
    fetchQboAccountBalance: async ({ accountId }: { accountId: string }) =>
      accountBalances.get(accountId) ?? null,
    queryQboReconActivity: async ({ entity }: { entity: string }) => ({
      rows: activityRows.filter((row) => row.entityType === entity),
      truncated: false,
    }),
  },
});

let stripeTxns: unknown[] = [];
mock.module("@/lib/stripe-balance", {
  namedExports: {
    listStripeBalanceTransactions: async () => ({
      txns: stripeTxns,
      pages: 1,
      truncated: false,
    }),
    fetchStripeBalanceTotals: async () => ({
      availableMinor: 500000,
      pendingMinor: 0,
      currency: "USD",
    }),
    fetchStripeChargeFacts: async () => ({}),
    fetchStripeRefundFacts: async () => ({}),
    fetchStripeChargeBalanceTransaction: async () => null,
  },
});

const actor = {
  token: { uid: "admin-1", email: "admin@example.test" },
  claims: { admin: true, role: "admin" },
  record: { uid: "admin-1", email: "admin@example.test" },
};

function assertNoUndefined(value: unknown, path = "doc"): void {
  if (value === undefined) {
    assert.fail(`undefined value at ${path}`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertNoUndefined(entry, `${path}[${i}]`));
    return;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    for (const [key, entry] of Object.entries(value)) {
      assertNoUndefined(entry, `${path}.${key}`);
    }
  }
}

beforeEach(() => {
  paymentDocs = [];
  storedDoc = undefined;
  setPayloads.length = 0;
  qboConfigured = true;
  mappingView = {
    mapping: {
      stripeClearingAccountId: "34",
      stripeFeeExpenseAccountId: "86",
    },
  };
  accountBalances.clear();
  accountBalances.set("34", {
    id: "34",
    name: "Stripe Clearing",
    balanceMinor: 499000,
    currency: "USD",
  });
  accountBalances.set("86", {
    id: "86",
    name: "Stripe Fees",
    balanceMinor: 12000,
    currency: "USD",
  });
  activityRows = [];
  stripeTxns = [];
  loggedErrors.length = 0;
});

describe("qboReconState persistence (Firestore-safe write boundary)", () => {
  it("persists a report whose ledger items lack docNumber and memo", async () => {
    const { runQboReconciliation } = await import("@/lib/qbo-recon");
    activityRows = [
      {
        entityType: "JournalEntry",
        id: "77",
        txnDate: "2026-05-10",
        docNumber: undefined,
        memo: undefined,
        legs: [{ accountId: "34", amountMinor: 1200 }],
      },
      {
        entityType: "Purchase",
        id: "88",
        memo: "Stripe fees",
        legs: [
          { accountId: "86", amountMinor: 320 },
          { accountId: "34", amountMinor: -320 },
        ],
      },
    ];

    const view = await runQboReconciliation({ actor } as never);

    assert.strictEqual(setPayloads.length, 1);
    const payload = setPayloads[0];
    assertNoUndefined(payload);

    // The exact production failure path — optional ledger fields are
    // absent keys, never undefined values. Items sort by txnDate, so
    // the undated Purchase precedes the dated JournalEntry.
    const items = (payload.view as FakeDoc).qboLedgerItems as FakeDoc[];
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].id, "88");
    assert.strictEqual(items[1].id, "77");
    assert.ok(!("docNumber" in items[0]));
    assert.ok(!("docNumber" in items[1]));
    assert.ok(!("memo" in items[1]));
    assert.strictEqual(items[0].memo, "Stripe fees");

    // Legitimate data survives: amounts, ids, legs, and the
    // FieldValue.serverTimestamp() sentinel pass through untouched.
    assert.strictEqual(items[1].amountMinor, 1200);
    assert.strictEqual(items[0].amountMinor, 0);
    assert.deepStrictEqual(items[1].accountIds, ["34"]);
    assert.deepStrictEqual(items[0].accountIds, ["86", "34"]);
    assert.strictEqual(payload.ranAt, SERVER_TS);
    assert.strictEqual(payload.environment, "sandbox");
    assert.strictEqual(view.qboLedgerItems.length, 2);
  });

  it("persists a report when the QBO leg is unavailable", async () => {
    const { runQboReconciliation } = await import("@/lib/qbo-recon");
    qboConfigured = false;

    await runQboReconciliation({ actor } as never);

    assert.strictEqual(setPayloads.length, 1);
    const payload = setPayloads[0];
    assertNoUndefined(payload);
    const view = payload.view as FakeDoc;
    assert.strictEqual(view.qboAvailable, false);
    // Optional balances the unavailable leg could not produce are
    // absent keys rather than undefined values.
    assert.ok(!("realmIdShort" in view));
    assert.ok(!("qboClearingBalanceMinor" in view));
    assert.deepStrictEqual(view.qboLedgerItems, []);
  });

  it("omits actor email when neither token nor record carries one", async () => {
    const { runQboReconciliation } = await import("@/lib/qbo-recon");
    const emailless = {
      token: { uid: "admin-1" },
      claims: { admin: true, role: "admin" },
      record: { uid: "admin-1" },
    };

    await runQboReconciliation({ actor: emailless } as never);

    const payload = setPayloads[0];
    assertNoUndefined(payload);
    assert.ok(!("ranByEmail" in payload));
    assert.ok(!("ranByEmail" in (payload.view as FakeDoc)));
  });

  it("round-trips the stored view through getQboReconLatest", async () => {
    const { runQboReconciliation, getQboReconLatest } = await import(
      "@/lib/qbo-recon"
    );
    activityRows = [
      {
        entityType: "JournalEntry",
        id: "77",
        txnDate: "2026-05-10",
        legs: [{ accountId: "34", amountMinor: 1200 }],
      },
    ];

    await runQboReconciliation({ actor } as never);
    storedDoc = setPayloads[0];

    const latest = await getQboReconLatest();
    assert.ok(latest);
    assert.strictEqual(latest!.qboLedgerItems.length, 1);
    assert.strictEqual(latest!.qboLedgerItems[0].id, "77");
    assert.strictEqual(latest!.qboLedgerItems[0].amountMinor, 1200);
    assert.strictEqual(latest!.realmIdShort, "9341…7654");
    assert.strictEqual(latest!.qboClearingBalanceMinor, 499000);
  });
});
