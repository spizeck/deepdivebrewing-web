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
  toMillis() {
    return this.ms;
  }
  static fromMillis(ms: number) {
    return new FakeTimestamp(ms);
  }
  static now() {
    return new FakeTimestamp(Date.now());
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

interface FakeDocRef {
  __coll?: string;
  __id?: string;
}

const fakeDb = {
  collection: makeCollection,
  batch: () => ({
    set: (ref: FakeDocRef, data: FakeDoc, opts?: { merge?: boolean }) => {
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
  runTransaction: async (
    work: (tx: {
      get: (ref: FakeDocRef) => Promise<{
        exists: boolean;
        data: () => FakeDoc | undefined;
      }>;
      set: (ref: FakeDocRef, data: FakeDoc, opts?: { merge?: boolean }) => void;
      update: (ref: FakeDocRef, data: FakeDoc) => void;
      create: (ref: FakeDocRef, data: FakeDoc) => void;
      delete: (ref: FakeDocRef) => void;
    }) => Promise<unknown>
  ) =>
    work({
      get: async (ref: FakeDocRef) => {
        const coll = collectionStore(ref.__coll ?? "");
        return {
          exists: coll.has(ref.__id ?? ""),
          data: () => coll.get(ref.__id ?? ""),
        };
      },
      set: (ref: FakeDocRef, data: FakeDoc, opts?: { merge?: boolean }) => {
        const coll = collectionStore(ref.__coll ?? "");
        coll.set(
          ref.__id ?? "",
          opts?.merge ? { ...coll.get(ref.__id ?? ""), ...data } : data
        );
      },
      update: (ref: FakeDocRef, data: FakeDoc) => {
        const coll = collectionStore(ref.__coll ?? "");
        coll.set(ref.__id ?? "", { ...coll.get(ref.__id ?? ""), ...data });
      },
      create: (ref: FakeDocRef, data: FakeDoc) => {
        collectionStore(ref.__coll ?? "").set(ref.__id ?? "", data);
      },
      delete: (ref: FakeDocRef) => {
        collectionStore(ref.__coll ?? "").delete(ref.__id ?? "");
      },
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
      runTransaction: fakeDb.runTransaction,
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
// Per-id payout facts for multi-payout sync tests — falls back to
// `stripePayout` so the single-payout describes keep working.
const payoutFactsById = new Map<string, FakeDoc | null>();
const payoutFetchErrors = new Set<string>();
let recentPayouts: FakeDoc[] = [];
let recentTruncated = false;
const recentListCalls: { createdGteSec: number; limit?: number; maxPages?: number }[] = [];
let stripeFetchError: Error | null = null;
let stripeListError: Error | null = null;
// Test seam for lease-loss scenarios: runs inside the canonical fetch,
// i.e. mid-item during a sync — lets a test simulate the TTL elapsing
// and a successor run acquiring the lock.
let onPayoutFetch: ((id: string) => void) | null = null;

mock.module("@/lib/stripe-balance", {
  namedExports: {
    fetchStripePayout: async (id: string) => {
      if (stripeFetchError || payoutFetchErrors.has(id)) {
        throw stripeFetchError ?? new Error(`stripe outage for ${id}`);
      }
      onPayoutFetch?.(id);
      return payoutFactsById.has(id) ? payoutFactsById.get(id) : stripePayout;
    },
    listStripePayoutTransactions: async () => ({
      txns: payoutTxns,
      truncated: false,
    }),
    listRecentStripePayouts: async (input: {
      createdGteSec: number;
      limit?: number;
      maxPages?: number;
    }) => {
      recentListCalls.push(input);
      if (stripeListError) throw stripeListError;
      return { payouts: recentPayouts, truncated: recentTruncated };
    },
    fetchStripeChargeFacts: async (id: string) => chargeFacts.get(id) ?? {},
    fetchStripeRefundFacts: async () => ({}),
  },
});

let accountingMode = "observe";
let cutover: string | null = null;
let stripeConfigured = true;
let stripeTestMode = true;
mock.module("@/lib/stripe-config", {
  namedExports: {
    getStripeAccountingMode: () => accountingMode,
    getStripeAutomationCutover: () => cutover,
    isStripeConfigured: () => stripeConfigured,
    isStripeTestMode: () => stripeTestMode,
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
  payoutFactsById.clear();
  payoutFetchErrors.clear();
  recentPayouts = [];
  recentTruncated = false;
  recentListCalls.length = 0;
  stripeFetchError = null;
  stripeListError = null;
  onPayoutFetch = null;
  stripeConfigured = true;
  stripeTestMode = true;
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

describe("syncStripePayouts", () => {
  function paidPayoutFacts(id: string): FakeDoc {
    return { ...PAID_PAYOUT, id };
  }

  it("processes missing payouts, records non-paid, and skips current ones", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    recentPayouts = [
      paidPayoutFacts("po_new"),
      { ...PAID_PAYOUT, id: "po_pending", status: "pending" },
      paidPayoutFacts("po_cur"),
    ];
    payoutFactsById.set("po_new", paidPayoutFacts("po_new"));
    payoutFactsById.set("po_cur", paidPayoutFacts("po_cur"));
    collectionStore("stripePayouts").set("po_cur", {
      payoutId: "po_cur",
      environment: "sandbox",
      status: "paid",
      pendingLedger: false,
      lastProcessedAt: FakeTimestamp.fromMillis(Date.now()),
    });

    const summary = await syncStripePayouts();
    assert.equal(summary.environment, "sandbox");
    assert.equal(summary.scope, "recent");
    assert.equal(summary.discovered, 3);
    assert.equal(summary.processed, 1);
    assert.equal(summary.statusRecorded, 1);
    assert.equal(summary.alreadyCurrent, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.remaining, 0);

    const built = collectionStore("stripePayouts").get("po_new")!;
    assert.equal(built.status, "paid");
    assert.ok(Array.isArray(built.lines));
    const pending = collectionStore("stripePayouts").get("po_pending")!;
    assert.equal(pending.status, "pending");
    assert.equal(pending.environment, "sandbox");
    // A second identical run is a no-op — the up-to-date check sees the
    // persisted docs and never touches the provider again.
    const again = await syncStripePayouts();
    assert.equal(again.processed, 0);
    assert.equal(again.statusRecorded, 0);
    assert.equal(again.alreadyCurrent, 3);
    // Proposals stay observe-mode only — no execution ever.
    for (const p of collectionStore("qboAccountingProposals").values()) {
      assert.notEqual(p.status, "applied");
    }
  });

  it("stops at the process cap and reports the backlog as remaining", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    recentPayouts = Array.from({ length: 12 }, (_, i) =>
      paidPayoutFacts(`po_${i}`)
    );
    for (const p of recentPayouts) {
      payoutFactsById.set(p.id as string, p);
    }
    const summary = await syncStripePayouts();
    assert.equal(summary.discovered, 12);
    assert.equal(summary.processed, 10);
    assert.equal(summary.remaining, 2);
    // The next run drains the rest — continuation via re-invocation.
    const second = await syncStripePayouts();
    assert.equal(second.processed, 2);
    assert.equal(second.remaining, 0);
  });

  it("paginates the bounded Stripe scan", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    await syncStripePayouts();
    assert.equal(recentListCalls.length, 1);
    assert.equal(recentListCalls[0].maxPages, 3);
    assert.equal(recentListCalls[0].limit, 100);
  });

  it("syncs a single payout by id through the same canonical build", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    const summary = await syncStripePayouts({ payoutId: "po_abc" });
    assert.equal(summary.scope, "single");
    assert.equal(summary.discovered, 1);
    assert.equal(summary.processed, 1);
    const item = summary.items[0];
    assert.equal(item.outcome, "processed");
    assert.equal(item.proposals, 3);
    assert.equal(item.eligibleLines, 1);
    assert.equal(collectionStore("stripePayouts").has("po_abc"), true);
    // The Stripe list is never consulted for a by-id sync.
    assert.equal(recentListCalls.length, 0);
  });

  it("rejects a malformed payout id before any provider call", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    await assert.rejects(
      () => syncStripePayouts({ payoutId: "pi_not_a_payout" }),
      (error: unknown) => (error as { status?: number }).status === 400
    );
    await assert.rejects(
      () => syncStripePayouts({ payoutId: "../etc" }),
      (error: unknown) => (error as { status?: number }).status === 400
    );
    assert.equal(recentListCalls.length, 0);
  });

  it("reports not_found for a payout absent from this Stripe environment", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    stripePayout = null;
    const summary = await syncStripePayouts({ payoutId: "po_missing" });
    assert.equal(summary.failed, 1);
    assert.equal(summary.items[0].outcome, "not_found");
    assert.equal(collectionStore("stripePayouts").has("po_missing"), false);
  });

  it("reports not_found when the payout's livemode contradicts the key mode", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    // A live-mode object reachable under a test key cannot be a
    // same-environment payout — the guard refuses to ingest it.
    payoutFactsById.set("po_live", {
      ...PAID_PAYOUT,
      id: "po_live",
      livemode: true,
    });
    const summary = await syncStripePayouts({ payoutId: "po_live" });
    assert.equal(summary.items[0].outcome, "not_found");
    assert.equal(summary.failed, 1);
  });

  it("marks a fully pre-cutover payout as ingested with zero proposals", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    cutover = "2026-10-14"; // charge movements are dated 2026-10-11
    const summary = await syncStripePayouts({ payoutId: "po_abc" });
    const item = summary.items[0];
    assert.equal(item.outcome, "processed");
    assert.equal(item.eligibleLines, 0);
    assert.equal(item.preCutoverLines, 1);
    assert.equal(item.proposals, 0);
    assert.equal(summary.cutover, "2026-10-14");
    // The ledger still persisted — for review — with no proposals.
    assert.equal(collectionStore("stripePayouts").has("po_abc"), true);
    assert.equal(collectionStore("qboAccountingProposals").size, 0);
  });

  it("records a non-paid payout by id without ledger work", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    stripePayout = { ...PAID_PAYOUT, status: "in_transit" };
    const summary = await syncStripePayouts({ payoutId: "po_abc" });
    assert.equal(summary.statusRecorded, 1);
    assert.equal(summary.items[0].outcome, "status_recorded");
  });

  it("refuses a second run while the sync lease is held", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    collectionStore("qboSweepState").set("stripePayoutSync-sandbox", {
      environment: "sandbox",
      owner: "concurrent-run",
      leaseUntil: FakeTimestamp.fromMillis(Date.now() + 60_000),
    });
    await assert.rejects(
      () => syncStripePayouts(),
      (error: unknown) => (error as { status?: number }).status === 409
    );
    // A stale lease is reclaimable — a crashed run must not wedge sync.
    collectionStore("qboSweepState").set("stripePayoutSync-sandbox", {
      environment: "sandbox",
      owner: "crashed-run",
      leaseUntil: FakeTimestamp.fromMillis(Date.now() - 1_000),
    });
    const summary = await syncStripePayouts();
    assert.equal(summary.failed, 0);
    // The run replaced the crashed lease with its own owner token and
    // released it on completion — the lock is free for the next run.
    const lease = collectionStore("qboSweepState").get(
      "stripePayoutSync-sandbox"
    )!;
    assert.notEqual(lease.owner, "crashed-run");
    const second = await syncStripePayouts();
    assert.equal(second.failed, 0);
  });

  it("stops processing when the lease is lost mid-run and never clears the successor's lock", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    recentPayouts = [paidPayoutFacts("po_1"), paidPayoutFacts("po_2")];
    payoutFactsById.set("po_1", paidPayoutFacts("po_1"));
    payoutFactsById.set("po_2", paidPayoutFacts("po_2"));
    // While po_1's ledger builds, this run's TTL elapses and a second
    // invocation legitimately reacquires the expired lock.
    onPayoutFetch = (id) => {
      if (id === "po_1") {
        collectionStore("qboSweepState").set("stripePayoutSync-sandbox", {
          environment: "sandbox",
          owner: "successor-run",
          leaseUntil: FakeTimestamp.fromMillis(Date.now() + 120_000),
        });
      }
    };
    const summary = await syncStripePayouts();
    // po_1 finished under our ownership; po_2 was handed to the
    // successor instead of being processed under its lease.
    assert.equal(summary.processed, 1);
    assert.equal(summary.remaining, 1);
    assert.equal(collectionStore("stripePayouts").has("po_1"), true);
    assert.equal(collectionStore("stripePayouts").has("po_2"), false);
    // The stale release could not clear the successor's lease.
    const lease = collectionStore("qboSweepState").get(
      "stripePayoutSync-sandbox"
    )!;
    assert.equal(lease.owner, "successor-run");
    assert.ok(
      (lease.leaseUntil as { toMillis(): number }).toMillis() > Date.now()
    );
  });

  it("serializes the cron sweep behind the same lease", async () => {
    const { runStripePayoutSweep } = await import("@/lib/stripe-payouts");
    collectionStore("qboSweepState").set("stripePayoutSync-sandbox", {
      environment: "sandbox",
      owner: "manual-sync-run",
      leaseUntil: FakeTimestamp.fromMillis(Date.now() + 60_000),
    });
    recentPayouts = [paidPayoutFacts("po_new")];
    payoutFactsById.set("po_new", paidPayoutFacts("po_new"));
    const skipped = await runStripePayoutSweep();
    assert.deepEqual(skipped, { scanned: 0, processed: 0, skipped: 0 });
    // With the lease free the sweep recovers the payout itself.
    collectionStore("qboSweepState").set("stripePayoutSync-sandbox", {
      environment: "sandbox",
      owner: "manual-sync-run",
      leaseUntil: FakeTimestamp.fromMillis(0),
    });
    const summary = await runStripePayoutSweep();
    assert.equal(summary.processed, 1);
  });

  it("sweep honors the same ownership rules — stops on lease loss, keeps the successor's lock", async () => {
    const { runStripePayoutSweep } = await import("@/lib/stripe-payouts");
    recentPayouts = [paidPayoutFacts("po_1"), paidPayoutFacts("po_2")];
    payoutFactsById.set("po_1", paidPayoutFacts("po_1"));
    payoutFactsById.set("po_2", paidPayoutFacts("po_2"));
    onPayoutFetch = (id) => {
      if (id === "po_1") {
        collectionStore("qboSweepState").set("stripePayoutSync-sandbox", {
          environment: "sandbox",
          owner: "manual-sync-run",
          leaseUntil: FakeTimestamp.fromMillis(Date.now() + 120_000),
        });
      }
    };
    const result = await runStripePayoutSweep();
    assert.equal(result.processed, 1);
    assert.equal(result.skipped, 1);
    assert.equal(collectionStore("stripePayouts").has("po_2"), false);
    const lease = collectionStore("qboSweepState").get(
      "stripePayoutSync-sandbox"
    )!;
    assert.equal(lease.owner, "manual-sync-run");
  });

  it("isolates a per-payout failure — the rest still process", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    recentPayouts = [paidPayoutFacts("po_ok"), paidPayoutFacts("po_bad")];
    payoutFactsById.set("po_ok", paidPayoutFacts("po_ok"));
    payoutFetchErrors.add("po_bad");
    const summary = await syncStripePayouts();
    assert.equal(summary.processed, 1);
    assert.equal(summary.failed, 1);
    const bad = summary.items.find((i) => i.payoutId === "po_bad")!;
    assert.equal(bad.outcome, "failed");
    assert.equal(collectionStore("stripePayouts").has("po_ok"), true);
  });

  it("propagates a Stripe list failure as a failed sync, not a partial one", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    stripeListError = new Error("connection reset");
    await assert.rejects(() => syncStripePayouts());
  });

  it("fails closed when Stripe is not configured", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    stripeConfigured = false;
    await assert.rejects(
      () => syncStripePayouts(),
      (error: unknown) => (error as { status?: number }).status === 500
    );
  });
});
