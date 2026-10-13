import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";

// Orchestration coverage for the Stripe payout ledger: webhook-record
// dedupe, canonical ledger construction, proposal persistence, the
// Firestore-safe write boundary (no undefined anywhere in stored docs),
// and decided-proposal-status preservation on rebuild. Every provider
// and Firestore boundary is mocked — no real Stripe or QBO calls.

mock.module("server-only", { namedExports: {} });

const SERVER_TS = new (class ServerTimestampSentinel {})();

class FakeTimestamp {
  constructor(public ms: number) {}
  toDate() {
    return new Date(this.ms);
  }
  static fromMillis(ms: number) {
    return new FakeTimestamp(ms);
  }
}

mock.module("firebase-admin/firestore", {
  namedExports: {
    FieldValue: { serverTimestamp: () => SERVER_TS },
    Timestamp: FakeTimestamp,
  },
});

// --- Fake Firestore ---

interface FakeDoc {
  [key: string]: unknown;
}

// collection name → doc id → doc data
const store = new Map<string, Map<string, FakeDoc>>();
const batchWrites: { coll: string; id: string; data: FakeDoc }[] = [];

function collectionStore(name: string): Map<string, FakeDoc> {
  let coll = store.get(name);
  if (!coll) {
    coll = new Map();
    store.set(name, coll);
  }
  return coll;
}

function matchesWhere(data: FakeDoc, field: string, value: unknown): boolean {
  // Dotted paths resolve nested fields ("qboRefs.paymentId").
  const resolved = field
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc !== null && typeof acc === "object"
          ? (acc as FakeDoc)[key]
          : undefined,
      data
    );
  if (Array.isArray(value)) {
    // `in` queries
    return value.includes(resolved);
  }
  return resolved === value;
}

interface FakeQuery {
  where: (field: string, op: string, value: unknown) => FakeQuery;
  orderBy: (...args: unknown[]) => FakeQuery;
  limit: (...args: unknown[]) => FakeQuery;
  get: () => Promise<{
    docs: { id: string; data: () => FakeDoc }[];
    size: number;
  }>;
}

function makeCollection(name: string) {
  const coll = collectionStore(name);
  const makeQuery = (
    wheres: { field: string; value: unknown }[] = []
  ): FakeQuery => ({
    where: (field: string, _op: string, value: unknown) =>
      makeQuery([...wheres, { field, value }]),
    orderBy: () => makeQuery(wheres),
    limit: () => makeQuery(wheres),
    get: async () => {
      const docs = [...coll.entries()]
        .filter(([, data]) =>
          wheres.every((w) => matchesWhere(data, w.field, w.value))
        )
        .map(([id, data]) => ({ id, data: () => data }));
      return { docs, size: docs.length };
    },
  });
  return {
    doc: (id: string) => ({
      get: async () => ({
        exists: coll.has(id),
        data: () => coll.get(id),
        id,
      }),
      set: async (data: FakeDoc, opts?: { merge?: boolean }) => {
        coll.set(id, opts?.merge ? { ...coll.get(id), ...data } : data);
      },
      update: async (data: FakeDoc) => {
        coll.set(id, { ...coll.get(id), ...data });
      },
    }),
    where: (field: string, op: string, value: unknown) =>
      makeQuery([{ field, value }]).where(field, op, value),
    orderBy: () => makeQuery(),
    limit: () => makeQuery(),
  };
}

const fakeDb = {
  collection: makeCollection,
  batch: () => ({
    set: (
      ref: { __coll?: string; __id?: string },
      data: FakeDoc,
      opts?: { merge?: boolean }
    ) => {
      batchWrites.push({
        coll: ref.__coll ?? "",
        id: ref.__id ?? "",
        data,
      });
      if (opts?.merge && ref.__coll && ref.__id) {
        const coll = collectionStore(ref.__coll);
        coll.set(ref.__id, { ...coll.get(ref.__id), ...data });
      } else if (ref.__coll && ref.__id) {
        collectionStore(ref.__coll).set(ref.__id, data);
      }
    },
    commit: async () => {},
  }),
};

mock.module("@/lib/firebase-admin-db", {
  namedExports: {
    getFirebaseAdminDb: () => ({
      collection: (name: string) => {
        const base = makeCollection(name);
        // Doc refs need coll/id for batch writes — wrap.
        return {
          ...base,
          doc: (id: string) => {
            const ref = base.doc(id);
            return Object.assign(ref, { __coll: name, __id: id });
          },
        };
      },
      batch: fakeDb.batch,
    }),
  },
});

mock.module("@/lib/qbo-config", {
  namedExports: {
    getQboEnvironment: () => "sandbox",
    isQboConfigured: () => true,
    QBO_ACCOUNTING_SCOPE: "com.intuit.quickbooks.accounting",
    QBO_AUTHORIZE_URL: "https://appcenter.intuit.com/connect/oauth2",
    QBO_TOKEN_URL:
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    QBO_REVOKE_URL:
      "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
    QBO_MINOR_VERSION: "75",
    qboApiBaseUrl: () => "https://sandbox-quickbooks.api.intuit.com",
  },
});

const loggedErrors: string[] = [];
mock.module("@/lib/log", {
  namedExports: {
    logError: (event: string) => void loggedErrors.push(event),
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
  mapping: {
    stripeClearingAccountId: "34",
    stripeFeeExpenseAccountId: "86",
    stripePayoutAccountId: "99",
  },
  entityNames: { "34": "Stripe Clearing", "86": "Stripe Fees", "99": "Bank" },
};
mock.module("@/lib/qbo-mapping", {
  namedExports: { getQboMappingView: async () => mappingView },
});

let qboPayments: FakeDoc[] = [];
let reconActivity: FakeDoc[] = [];
let ufAccount: { id: string; name: string } | null = {
  id: "uf-1",
  name: "Undeposited Funds",
};

mock.module("@/lib/qbo-api", {
  namedExports: {
    findQboUndepositedFundsAccount: async () => ufAccount,
    queryQboPayments: async () => ({
      rows: qboPayments,
      truncated: false,
    }),
    queryQboReconActivity: async ({ entity }: { entity: string }) => ({
      rows: reconActivity.filter((r) => r.entityType === entity),
      truncated: false,
    }),
    fetchQboAccountBalance: async () => null,
  },
});

let stripePayout: FakeDoc | null = null;
let payoutTxns: FakeDoc[] = [];
const chargeFacts = new Map<string, FakeDoc>();

mock.module("@/lib/stripe-balance", {
  namedExports: {
    fetchStripePayout: async () => stripePayout,
    listStripePayoutTransactions: async () => ({
      txns: payoutTxns,
      truncated: false,
    }),
    listRecentStripePayouts: async () => [],
    fetchStripeChargeFacts: async (id: string) => chargeFacts.get(id) ?? {},
    fetchStripeRefundFacts: async () => ({}),
  },
});

let accountingMode = "observe";
let cutover: string | null = null;
mock.module("@/lib/stripe-config", {
  namedExports: {
    getStripeAccountingMode: () => accountingMode,
    getStripeAutomationCutover: () => cutover,
    isStripeConfigured: () => true,
  },
});

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

const PAID_PAYOUT = {
  id: "po_abc",
  status: "paid",
  amountMinor: 9680,
  currency: "USD",
  arrivalDate: "2026-10-15",
  createdMs: Date.parse("2026-10-13T00:00:00.000Z"),
};

const CHARGE = {
  txnId: "txn_1",
  type: "charge",
  grossMinor: 10000,
  feeMinor: 320,
  netMinor: 9680,
  currency: "USD",
  sourceId: "ch_ollie",
  createdMs: Date.parse("2026-10-11T00:00:00.000Z"),
};

const OLLIE_PAYMENT = {
  id: "42",
  txnDate: "2026-10-11",
  totalMinor: 10000,
  depositToAccountId: "uf-1",
  currency: "USD",
  customerName: "Sea Saba",
  refNumber: "Ollie Payment #1626166",
  memo: undefined,
  linkedTxnIds: ["inv-1"],
};

beforeEach(() => {
  store.clear();
  batchWrites.length = 0;
  loggedErrors.length = 0;
  stripePayout = { ...PAID_PAYOUT };
  payoutTxns = [{ ...CHARGE }];
  chargeFacts.clear();
  qboPayments = [{ ...OLLIE_PAYMENT }];
  reconActivity = [];
  ufAccount = { id: "uf-1", name: "Undeposited Funds" };
  accountingMode = "observe";
  cutover = null;
  mappingView = {
    mapping: {
      stripeClearingAccountId: "34",
      stripeFeeExpenseAccountId: "86",
      stripePayoutAccountId: "99",
    },
    entityNames: { "34": "Stripe Clearing", "86": "Stripe Fees", "99": "Bank" },
  };
});

describe("recordStripePayoutEvent", () => {
  it("records the canonical payout and returns needsLedgerBuild for paid", async () => {
    const { recordStripePayoutEvent } = await import("@/lib/stripe-payouts");
    const result = await recordStripePayoutEvent({
      eventId: "evt_1",
      eventType: "payout.paid",
      payoutId: "po_abc",
    });
    assert.equal(result.status, "applied");
    assert.equal(result.needsLedgerBuild, true);
    const stored = collectionStore("stripePayouts").get("po_abc")!;
    assert.equal(stored.status, "paid");
    assert.equal(stored.pendingLedger, true);
    assertNoUndefined(stored);
    // Dedupe marker written in the same batch.
    assert.ok(collectionStore("stripeEvents").has("evt_1"));
  });

  it("returns duplicate for a replayed event without provider calls", async () => {
    const { recordStripePayoutEvent } = await import("@/lib/stripe-payouts");
    collectionStore("stripeEvents").set("evt_1", { result: "payout_recorded" });
    stripePayout = null; // would fail the fetch if reached
    const result = await recordStripePayoutEvent({
      eventId: "evt_1",
      eventType: "payout.paid",
      payoutId: "po_abc",
    });
    assert.equal(result.status, "duplicate");
  });

  it("records a created payout without scheduling the ledger build", async () => {
    const { recordStripePayoutEvent } = await import("@/lib/stripe-payouts");
    stripePayout = { ...PAID_PAYOUT, status: "pending" };
    const result = await recordStripePayoutEvent({
      eventId: "evt_2",
      eventType: "payout.created",
      payoutId: "po_abc",
    });
    assert.equal(result.status, "applied");
    assert.equal(result.needsLedgerBuild, false);
  });
});

describe("processStripePayoutLedger", () => {
  it("builds a balanced ledger and proposes all three entries", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    await processStripePayoutLedger("po_abc");

    const doc = collectionStore("stripePayouts").get("po_abc")!;
    assert.equal(doc.status, "paid");
    assert.equal((doc.totals as FakeDoc).balanced, true);
    assert.equal((doc.totals as FakeDoc).feesMinor, 320);
    const lines = doc.lines as FakeDoc[];
    assert.equal(lines.length, 1);
    assert.equal(lines[0].lane, "ollie");
    assert.equal(lines[0].confidence, "suggested");
    assert.equal(lines[0].qboPaymentId, "42");

    const proposals = [...collectionStore("qboAccountingProposals").values()];
    assert.equal(proposals.length, 3);
    const kinds = proposals.map((p) => p.kind).sort();
    assert.deepEqual(kinds, [
      "move_payment_to_clearing",
      "payout_transfer",
      "stripe_fee_expense",
    ]);
    assert.ok(proposals.every((p) => p.status === "proposed"));
    assert.ok(proposals.every((p) => p.environment === "sandbox"));

    // Nothing in the persisted docs is undefined.
    assertNoUndefined(doc);
    proposals.forEach((p, i) => assertNoUndefined(p, `proposal[${i}]`));
  });

  it("skips the ledger fetch for non-paid payouts", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    stripePayout = { ...PAID_PAYOUT, status: "in_transit" };
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    assert.equal(doc.status, "in_transit");
    assert.deepEqual(doc.lines, []);
    assert.equal(collectionStore("qboAccountingProposals").size, 0);
  });

  it("confirms DDB identity via stored charge id without Ollie matching", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    collectionStore("payments").set("pay_1", {
      stripeChargeId: "ch_ollie",
      status: "paid",
    });
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const line = (doc.lines as FakeDoc[])[0];
    assert.equal(line.lane, "ddb");
    assert.equal(line.confidence, "confirmed");
    assert.equal(line.paymentId, "pay_1");
    // No reclassification proposal — DDB payments post via the Sales
    // Receipt path, never through the Ollie UF move.
    const proposals = [...collectionStore("qboAccountingProposals").values()];
    assert.equal(
      proposals.some((p) => p.kind === "move_payment_to_clearing"),
      false
    );
  });

  it("flags ambiguity when two UF payments match amount and date", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    qboPayments = [{ ...OLLIE_PAYMENT }, { ...OLLIE_PAYMENT, id: "77" }];
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const line = (doc.lines as FakeDoc[])[0];
    assert.equal(line.confidence, "ambiguous");
    const exceptions = doc.exceptions as FakeDoc[];
    assert.ok(exceptions.some((e) => e.code === "ambiguous_match"));
  });

  it("preserves a decided proposal status across rebuilds", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    await processStripePayoutLedger("po_abc");
    const moveId = "sandbox:po_abc:move_payment_to_clearing:42";
    collectionStore("qboAccountingProposals").get(moveId)!.status = "approved";
    await processStripePayoutLedger("po_abc");
    const proposal = collectionStore("qboAccountingProposals").get(moveId)!;
    assert.equal(proposal.status, "approved");
    const trail = proposal.auditTrail as FakeDoc[];
    assert.equal(trail.length, 2);
  });

  it("suppresses fee/transfer proposals when manual QBO entries already cover them", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    reconActivity = [
      {
        entityType: "Purchase",
        id: "m1",
        legs: [{ accountId: "86", amountMinor: 320 }],
      },
      {
        entityType: "Transfer",
        id: "m2",
        legs: [{ accountId: "34", amountMinor: 9680 }],
      },
    ];
    await processStripePayoutLedger("po_abc");
    const proposals = [...collectionStore("qboAccountingProposals").values()];
    assert.equal(
      proposals.some((p) => p.kind === "stripe_fee_expense"),
      false
    );
    assert.equal(
      proposals.some((p) => p.kind === "payout_transfer"),
      false
    );
  });

  it("blocks proposals when required mappings are unset", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    mappingView = { mapping: {} };
    await processStripePayoutLedger("po_abc");
    const proposals = [...collectionStore("qboAccountingProposals").values()];
    assert.ok(proposals.length > 0);
    assert.ok(proposals.every((p) => p.status === "blocked"));
  });

  it("classifies but never proposes pre-cutover movements", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    cutover = "2026-10-14"; // payout charges are dated 2026-10-11
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const line = (doc.lines as FakeDoc[])[0];
    assert.equal(line.scope, "pre_cutover");
    assert.equal(collectionStore("qboAccountingProposals").size, 0);
  });

  it("classifies with no matching UF payment candidates", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    qboPayments = [];
    mappingView = { mapping: {} };
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    assert.equal((doc.lines as FakeDoc[])[0].lane, "external");
    assert.equal(doc.qboAvailable, true); // leg ran, just no candidates
  });

  it("fails closed when Undeposited Funds cannot be identified", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    ufAccount = null;
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    // No UF account → no candidates, no move proposals — never guessed
    // matches. Aggregate proposals may still exist but must be blocked.
    assert.equal(doc.qboAvailable, false);
    assert.equal((doc.lines as FakeDoc[])[0].lane, "external");
    const proposals = [...collectionStore("qboAccountingProposals").values()];
    assert.equal(
      proposals.filter((p) => p.kind === "move_payment_to_clearing").length,
      0
    );
    for (const p of proposals) assert.equal(p.status, "blocked");
  });
});
