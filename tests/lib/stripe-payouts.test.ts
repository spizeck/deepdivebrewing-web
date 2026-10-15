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

const DELETE_FIELD = Symbol("firestore.deleteField");

mock.module("firebase-admin/firestore", {
  namedExports: {
    FieldPath: { documentId: () => "__name__" },
    FieldValue: {
      serverTimestamp: () => SERVER_TS,
      delete: () => DELETE_FIELD,
    },
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
// Test-only seam: hooks run inside the fake's batch commit — after the
// batch writes land but before the per-document merge transactions —
// simulating a decision committed mid-build against live state.
const midBuildHooks: (() => void)[] = [];

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

// Merge writes honoring the FieldValue.delete() sentinel — a shallow
// spread would store the marker instead of removing the key.
function mergeInto(coll: Map<string, FakeDoc>, id: string, data: FakeDoc) {
  const next: FakeDoc = { ...coll.get(id) };
  for (const [key, value] of Object.entries(data)) {
    if (value === DELETE_FIELD) delete next[key];
    else next[key] = value;
  }
  coll.set(id, next);
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
        mergeInto(collectionStore(ref.__coll), ref.__id, data);
      } else if (ref.__coll && ref.__id) {
        collectionStore(ref.__coll).set(ref.__id, data);
      }
    },
    commit: async () => {
      const hooks = midBuildHooks.splice(0);
      for (const hook of hooks) hook();
    },
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
        if (opts?.merge) {
          mergeInto(coll, ref.__id ?? "", data);
        } else {
          coll.set(ref.__id ?? "", data);
        }
      },
      update: (ref: FakeDocRef, data: FakeDoc) => {
        mergeInto(collectionStore(ref.__coll ?? ""), ref.__id ?? "", data);
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
let qboInvoices: FakeDoc[] = [];
let qboInvoiceError: Error | null = null;
let reconActivity: FakeDoc[] = [];
// Live single-payment reads — the reconciled-identity revalidation path.
// Entries absent from the map read as a deleted payment (null); an entry
// of `null` simulates the same, and a thrown error simulates an outage.
const qboPaymentsById = new Map<string, FakeDoc | null>();
let qboPaymentFetchError: Error | null = null;
// PaymentRefNum-targeted lookups for Spreedly-claimed references.
const qboRefNumPayments = new Map<string, FakeDoc[]>();
let qboRefNumError: Error | null = null;
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
    queryQboInvoices: async ({ ids }: { ids: string[] }) => {
      if (qboInvoiceError) throw qboInvoiceError;
      return qboInvoices.filter((inv) => ids.includes(inv.id as string));
    },
    queryQboReconActivity: async ({ entity }: { entity: string }) => ({
      rows: reconActivity.filter((r) => r.entityType === entity),
      truncated: false,
    }),
    fetchQboPaymentById: async ({ paymentId }: { paymentId: string }) => {
      if (qboPaymentFetchError) throw qboPaymentFetchError;
      return qboPaymentsById.get(paymentId) ?? null;
    },
    queryQboPaymentsByRefNum: async ({ refNum }: { refNum: string }) => {
      if (qboRefNumError) throw qboRefNumError;
      return qboRefNumPayments.get(refNum) ?? [];
    },
    fetchQboAccountBalance: async () => null,
  },
});

let stripePayout: FakeDoc | null = null;
let payoutTxns: FakeDoc[] = [];
let payoutTxnsTruncated = false;
const chargeFacts = new Map<string, FakeDoc>();
// Per-charge enrichment failures (Stripe read unavailable — the payout
// build must degrade to reference-free matching, not fail).
const chargeFactsErrors = new Set<string>();
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
      truncated: payoutTxnsTruncated,
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
    fetchStripeChargeFacts: async (id: string) => {
      if (chargeFactsErrors.has(id)) {
        throw new Error(`charge read failed for ${id}`);
      }
      return chargeFacts.get(id) ?? {};
    },
    fetchStripeRefundFacts: async () => ({}),
  },
});

// The guarded executor is exercised in its own suite — here it is a
// stub so the orchestration's automatic-mode pass can be driven to any
// outcome, including throws.
const applyCalls: { proposalId: string; auto: boolean }[] = [];
let applyOutcome = "applied";
let applyError: Error | null = null;
mock.module("@/lib/stripe-payout-executor", {
  namedExports: {
    applyPayoutProposal: async (input: {
      proposalId: string;
      auto?: boolean;
    }) => {
      applyCalls.push({
        proposalId: input.proposalId,
        auto: input.auto === true,
      });
      if (applyError) throw applyError;
      return { apply: { outcome: applyOutcome } };
    },
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
  midBuildHooks.length = 0;
  loggedErrors.length = 0;
  stripePayout = { ...PAID_PAYOUT };
  payoutTxns = [{ ...CHARGE }];
  payoutTxnsTruncated = false;
  applyCalls.length = 0;
  applyOutcome = "applied";
  applyError = null;
  chargeFacts.clear();
  chargeFactsErrors.clear();
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
  qboInvoices = [{ id: "inv-1", docNumber: "00327" }];
  qboPaymentsById.clear();
  qboPaymentFetchError = null;
  qboRefNumPayments.clear();
  qboRefNumError = null;
  qboInvoiceError = null;
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

  it("flags a DDB charge whose Sales Receipt sync record is missing", async () => {
    // Oct-4 "QBO Test" regression: balanced payout, missing gross — the
    // line must not read as fully reconciled.
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    collectionStore("payments").set("pay_1", {
      stripeChargeId: "ch_ollie",
      status: "paid",
    });
    // No qboSyncRecords doc for pay_1 — receipt unproven.
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const line = (doc.lines as FakeDoc[])[0];
    assert.equal(line.lane, "ddb");
    assert.ok((line.evidence as string[]).includes("ddb_receipt_unverified"));
    const exceptions = doc.exceptions as FakeDoc[];
    assert.ok(exceptions.some((e) => e.code === "ddb_receipt_unposted"));
  });

  it("does not flag a DDB charge whose sync record is synced", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    collectionStore("payments").set("pay_1", {
      stripeChargeId: "ch_ollie",
      status: "paid",
    });
    const syncId = "sandbox:stripe_payment:pay_1";
    collectionStore("qboSyncRecords").set(syncId, {
      __name__: syncId,
      status: "synced",
      qboEntityId: "sr-1",
    });
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const exceptions = doc.exceptions as FakeDoc[];
    assert.ok(!exceptions.some((e) => e.code === "ddb_receipt_unposted"));
  });

  it("flags a DDB charge whose synced record carries no QBO entity", async () => {
    // `synced` without a qboEntityId is unfinished evidence — the
    // receipt it claims to have created cannot be named.
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    collectionStore("payments").set("pay_1", {
      stripeChargeId: "ch_ollie",
      status: "paid",
    });
    const syncId = "sandbox:stripe_payment:pay_1";
    collectionStore("qboSyncRecords").set(syncId, {
      __name__: syncId,
      status: "synced",
    });
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const exceptions = doc.exceptions as FakeDoc[];
    assert.ok(
      exceptions.some(
        (e) =>
          e.code === "ddb_receipt_unposted" &&
          (e.detail as string).includes("synced_no_entity")
      )
    );
  });

  it("flags a DDB charge whose sync record needs attention", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    collectionStore("payments").set("pay_1", {
      stripeChargeId: "ch_ollie",
      status: "paid",
    });
    const syncId = "sandbox:stripe_payment:pay_1";
    collectionStore("qboSyncRecords").set(syncId, {
      __name__: syncId,
      status: "needs_attention",
    });
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const exceptions = doc.exceptions as FakeDoc[];
    assert.ok(exceptions.some((e) => e.code === "ddb_receipt_unposted"));
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

  it("verifies via Stripe order ref ↔ linked invoice DocNumber", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    // Ollie's Stripe charge description names the order; the QBO
    // payment's linked invoice DocNumber carries the same number —
    // the documented #00327 → #00327 chain.
    chargeFacts.set("ch_ollie", {
      description: "Ollie Order #00327",
      billingName: "Sea Saba",
    });
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const line = (doc.lines as FakeDoc[])[0];
    assert.equal(line.confidence, "verified");
    assert.deepEqual(line.identityRefs, ["order-invoice:327"]);
    assert.equal(line.qboPaymentId, "42");
    // Verified lines still generate proposals — observe-only, but now
    // backed by identity evidence, not just amount+date.
    const proposals = [...collectionStore("qboAccountingProposals").values()];
    assert.ok(
      proposals.some((p) => p.kind === "move_payment_to_clearing")
    );
  });

  it("verifies via Stripe metadata payment number ↔ PaymentRefNum", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    chargeFacts.set("ch_ollie", {
      metadata: { olliePaymentNumber: "1626166" },
    });
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const line = (doc.lines as FakeDoc[])[0];
    assert.equal(line.confidence, "verified");
    assert.deepEqual(line.identityRefs, ["payment:1626166"]);
  });

  it("fails closed when the Stripe ref contradicts the QBO payment", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    // Stripe says order #00399; the only amount/date candidate links
    // invoice #00327 — contradictory identifiers, never a match.
    chargeFacts.set("ch_ollie", { description: "Ollie Order #00399" });
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const line = (doc.lines as FakeDoc[])[0];
    assert.equal(line.confidence, "ambiguous");
    assert.ok(
      (doc.exceptions as FakeDoc[]).some((e) => e.code === "ambiguous_match")
    );
    // And no executable artifact is produced for the line.
    const proposals = [...collectionStore("qboAccountingProposals").values()];
    assert.equal(
      proposals.some((p) => p.kind === "move_payment_to_clearing"),
      false
    );
  });

  it("stays suggested when Stripe carries no Ollie identifiers", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    chargeFacts.set("ch_ollie", { description: "Card payment" });
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const line = (doc.lines as FakeDoc[])[0];
    assert.equal(line.confidence, "suggested");
    assert.equal(line.qboPaymentId, "42");
  });

  it("survives a linked-invoice lookup failure — suggests, never crashes", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    chargeFacts.set("ch_ollie", {
      description: "Ollie Order #00327",
    });
    qboInvoiceError = new Error("qbo invoice query failed");
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const line = (doc.lines as FakeDoc[])[0];
    // Without DocNumbers the order↔invoice chain cannot be evaluated —
    // the match degrades to circumstantial, not verified.
    assert.equal(line.confidence, "suggested");
    assert.equal(doc.qboAvailable, true);
  });

  it("preserves a decided proposal status across rebuilds", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    const { proposalMaterialFingerprint } = await import(
      "@/lib/stripe-payouts-common"
    );
    await processStripePayoutLedger("po_abc");
    const moveId = "sandbox:po_abc:move_payment_to_clearing:42";
    const stored = collectionStore("qboAccountingProposals").get(moveId)!;
    // An approval binds to the proposal's material fingerprint.
    stored.status = "approved";
    stored.decision = {
      action: "approve",
      actorUid: "admin-1",
      at: "2026-10-15T00:00:00.000Z",
      fingerprint: proposalMaterialFingerprint(
        stored as Parameters<typeof proposalMaterialFingerprint>[0]
      ),
    };
    await processStripePayoutLedger("po_abc");
    const proposal = collectionStore("qboAccountingProposals").get(moveId)!;
    assert.equal(proposal.status, "approved");
    const trail = proposal.auditTrail as FakeDoc[];
    assert.equal(trail.length, 2);
  });

  it("invalidates an approval when material facts change on rebuild", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    const { proposalMaterialFingerprint } = await import(
      "@/lib/stripe-payouts-common"
    );
    await processStripePayoutLedger("po_abc");
    const moveId = "sandbox:po_abc:move_payment_to_clearing:42";
    const stored = collectionStore("qboAccountingProposals").get(moveId)!;
    stored.status = "approved";
    const approval = {
      action: "approve",
      actorUid: "admin-1",
      at: "2026-10-15T00:00:00.000Z",
      fingerprint: proposalMaterialFingerprint(
        stored as Parameters<typeof proposalMaterialFingerprint>[0]
      ),
    };
    stored.decision = approval;
    stored.decisions = [approval];
    // The clearing account mapping changes between builds — the debit
    // leg is materially different, so the prior approval cannot stand.
    mappingView = {
      mapping: {
        stripeClearingAccountId: "55",
        stripeFeeExpenseAccountId: "86",
        stripePayoutAccountId: "99",
      },
      entityNames: { "55": "Stripe Clearing" },
    };
    await processStripePayoutLedger("po_abc");
    const proposal = collectionStore("qboAccountingProposals").get(moveId)!;
    assert.equal(proposal.status, "proposed");
    const trail = proposal.auditTrail as FakeDoc[];
    assert.ok(
      trail.some((t) =>
        (t.note as string).includes("approval invalidated")
      )
    );
    // The current decision is cleared — a reverted proposal must not
    // carry a stale approve binding — while `decisions` keeps the
    // superseded record durably.
    assert.equal(proposal.decision, undefined);
    assert.deepEqual(proposal.decisions, [approval]);
  });

  it("downgrades a legacy approved proposal with no fingerprint", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    await processStripePayoutLedger("po_abc");
    const moveId = "sandbox:po_abc:move_payment_to_clearing:42";
    // Pre-fingerprint approval — no decision record at all.
    collectionStore("qboAccountingProposals").get(moveId)!.status =
      "approved";
    await processStripePayoutLedger("po_abc");
    assert.equal(
      collectionStore("qboAccountingProposals").get(moveId)!.status,
      "proposed"
    );
  });

  it("preserves a decision committed after the rebuild's snapshot", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    await processStripePayoutLedger("po_abc");
    const moveId = "sandbox:po_abc:move_payment_to_clearing:42";
    // The approval lands between the rebuild's proposal scan and its
    // merge — the snapshot holds `proposed`, but the live doc carries a
    // valid fingerprint-bound approval. A stale-snapshot write would
    // silently revert it to proposed.
    midBuildHooks.push(() => {
      const stored =
        collectionStore("qboAccountingProposals").get(moveId)!;
      stored.status = "approved";
      stored.decision = {
        action: "approve",
        actorUid: "admin-1",
        at: "2026-10-15T01:00:00.000Z",
        fingerprint: stored.materialFingerprint,
      };
    });
    await processStripePayoutLedger("po_abc");
    const proposal = collectionStore("qboAccountingProposals").get(moveId)!;
    assert.equal(proposal.status, "approved");
  });

  it("an invalidated approval reverts to blocked — never back to approvable", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    const { proposalMaterialFingerprint } = await import(
      "@/lib/stripe-payouts-common"
    );
    await processStripePayoutLedger("po_abc");
    const moveId = "sandbox:po_abc:move_payment_to_clearing:42";
    const stored = collectionStore("qboAccountingProposals").get(moveId)!;
    stored.status = "approved";
    stored.decision = {
      action: "approve",
      actorUid: "admin-1",
      at: "2026-10-15T00:00:00.000Z",
      fingerprint: proposalMaterialFingerprint(
        stored as Parameters<typeof proposalMaterialFingerprint>[0]
      ),
    };
    // The clearing mapping disappears — the rebuilt proposal is blocked,
    // and the stale approval must not turn it into an approvable
    // `proposed`.
    mappingView = { mapping: {}, entityNames: {} };
    await processStripePayoutLedger("po_abc");
    assert.equal(
      collectionStore("qboAccountingProposals").get(moveId)!.status,
      "blocked"
    );
  });

  it("does not stale-mark a proposal that went terminal mid-build", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    await processStripePayoutLedger("po_abc");
    const moveId = "sandbox:po_abc:move_payment_to_clearing:42";
    // Scan sees `proposed`; before the merge the admin rejects it. The
    // stale pass must observe the live terminal status, not the snapshot.
    midBuildHooks.push(() => {
      const stored =
        collectionStore("qboAccountingProposals").get(moveId)!;
      stored.status = "rejected";
      stored.decision = {
        action: "reject",
        actorUid: "admin-1",
        at: "2026-10-15T01:00:00.000Z",
        fingerprint: stored.materialFingerprint,
      };
    });
    cutover = "2026-10-14"; // every movement excluded — nothing recomputes
    await processStripePayoutLedger("po_abc");
    assert.equal(
      collectionStore("qboAccountingProposals").get(moveId)!.status,
      "rejected"
    );
  });

  it("marks live proposals stale when the rebuild stops producing them", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    await processStripePayoutLedger("po_abc");
    const proposals = collectionStore("qboAccountingProposals");
    const moveId = "sandbox:po_abc:move_payment_to_clearing:42";
    const feeId = "sandbox:po_abc:stripe_fee_expense:aggregate";
    const transferId = "sandbox:po_abc:payout_transfer:aggregate";
    // Terminal and decided states going into the rebuild: one approved,
    // one rejected — the third stays proposed.
    proposals.get(moveId)!.status = "approved";
    proposals.get(transferId)!.status = "rejected";

    // A cutover that now excludes every movement → the eligible
    // aggregates stop recomputing; the move re-emerges as a historical
    // (manual-only) variant under the same id.
    cutover = "2026-10-14";
    await processStripePayoutLedger("po_abc");

    // Live statuses can no longer masquerade as current computation —
    // the move proposal's material facts changed (it is now historical),
    // so the stale approval is invalidated back to `proposed`; the
    // eligible aggregates stop recomputing entirely and go stale;
    // rejected stays terminal.
    const moveDoc = proposals.get(moveId)!;
    assert.equal(moveDoc.status, "proposed");
    assert.equal(moveDoc.historical, true);
    assert.equal(moveDoc.autoEligible, false);
    assert.equal(proposals.get(feeId)!.status, "stale");
    assert.equal(proposals.get(transferId)!.status, "rejected");
    // A historical variant of the aggregates now exists for manual
    // reconciliation — never eligible.
    const histFee = proposals.get(
      "sandbox:po_abc:stripe_fee_expense:historical"
    )!;
    assert.equal(histFee.historical, true);
    assert.equal(histFee.autoEligible, false);
    const trail = proposals.get(feeId)!.auditTrail as FakeDoc[];
    assert.ok(
      (trail.at(-1)!.note as string).includes("marked stale")
    );

    // Stale is not decided — remove the cutover and the proposals revive.
    cutover = null;
    await processStripePayoutLedger("po_abc");
    assert.equal(proposals.get(moveId)!.status, "proposed");
    assert.equal(proposals.get(feeId)!.status, "proposed");
    // The terminal rejection is still preserved across the rebuild.
    assert.equal(proposals.get(transferId)!.status, "rejected");
  });

  it("never marks a move proposal stale while the QBO leg is unavailable", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    await processStripePayoutLedger("po_abc");
    const proposals = collectionStore("qboAccountingProposals");
    const moveId = "sandbox:po_abc:move_payment_to_clearing:42";
    proposals.get(moveId)!.status = "approved";

    // QBO leg down: no UF account, no candidates — the move proposal
    // cannot recompute, but absence here is an outage artifact, not
    // evidence. The approval must survive.
    ufAccount = null;
    await processStripePayoutLedger("po_abc");
    assert.equal(proposals.get(moveId)!.status, "approved");

    // When QBO recovers and the payment genuinely resolves elsewhere,
    // staleness applies again.
    ufAccount = { id: "uf", name: "Undeposited Funds" };
    qboPayments = [];
    await processStripePayoutLedger("po_abc");
    assert.equal(proposals.get(moveId)!.status, "stale");
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

  it("never lets one share's marker-stamped entry suppress the other share's proposal", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    // Straddling payout: the CHARGE movement (Oct 11) is on/after the
    // cutover → eligible (fee 320); txn_old (Oct 10) predates it →
    // pre-cutover (fee 200). The eligible JE already posted for the
    // eligible share carries the DDB-PAYOUT-FEE: marker — even though
    // its amount happens to equal the pre-cutover fee sum, it must not
    // suppress the historical proposal.
    cutover = "2026-10-11";
    payoutTxns = [
      { ...CHARGE },
      {
        ...CHARGE,
        txnId: "txn_old",
        sourceId: "ch_old",
        grossMinor: 5000,
        feeMinor: 200,
        netMinor: 4800,
        createdMs: Date.parse("2026-10-10T00:00:00.000Z"),
      },
    ];
    reconActivity = [
      {
        entityType: "JournalEntry",
        id: "je-eligible",
        memo: "DDB-PAYOUT-FEE:po_abc",
        legs: [
          { accountId: "86", amountMinor: 200 },
          { accountId: "34", amountMinor: -200 },
        ],
      },
    ];
    await processStripePayoutLedger("po_abc");
    const proposals = collectionStore("qboAccountingProposals");
    assert.ok(
      proposals.has("sandbox:po_abc:stripe_fee_expense:historical"),
      "historical fee proposal survives an eligible-marker entry"
    );

    // Mirror image: a -HIST entry matching the eligible fee sum must
    // not suppress the eligible proposal.
    reconActivity = [
      {
        entityType: "JournalEntry",
        id: "je-hist",
        memo: "DDB-PAYOUT-FEE-HIST:po_abc",
        legs: [
          { accountId: "86", amountMinor: 320 },
          { accountId: "34", amountMinor: -320 },
        ],
      },
    ];
    await processStripePayoutLedger("po_abc");
    assert.ok(
      proposals.has("sandbox:po_abc:stripe_fee_expense:aggregate"),
      "eligible fee proposal survives a historical-marker entry"
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

  it("classifies pre-cutover movements into manual-only historical proposals", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    cutover = "2026-10-14"; // payout charges are dated 2026-10-11
    await processStripePayoutLedger("po_abc");
    const doc = collectionStore("stripePayouts").get("po_abc")!;
    const line = (doc.lines as FakeDoc[])[0];
    assert.equal(line.scope, "pre_cutover");
    // Pre-cutover movements now produce historical proposals — every one
    // flagged manual-only, never auto-eligible, with the original
    // classification preserved on the line.
    const proposals = [...collectionStore("qboAccountingProposals").values()];
    assert.ok(proposals.length > 0);
    for (const p of proposals) {
      assert.equal(p.historical, true);
      assert.equal(p.autoEligible, false);
    }
    const move = proposals.find(
      (p) => p.kind === "move_payment_to_clearing"
    )!;
    assert.equal(move.lineConfidence, "suggested");
    assert.equal(
      (move.qboRefs as { paymentId?: string } | undefined)?.paymentId,
      "42"
    );
  });

  it("preserves a confirmed historical approval across reprocessing", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    const { proposalMaterialFingerprint } = await import(
      "@/lib/stripe-payouts-common"
    );
    cutover = "2026-10-14"; // payout charges are dated 2026-10-11
    await processStripePayoutLedger("po_abc");
    const proposals = collectionStore("qboAccountingProposals");
    const moveId = "sandbox:po_abc:move_payment_to_clearing:42";
    const stored = proposals.get(moveId)!;
    // Simulate the admin's confirmed approval — bound to the current
    // fingerprint and naming the exact QBO payment.
    stored.status = "approved";
    stored.decision = {
      action: "approve",
      actorUid: "admin-1",
      at: "2026-10-15T00:00:00.000Z",
      fingerprint: proposalMaterialFingerprint(
        stored as Parameters<typeof proposalMaterialFingerprint>[0]
      ),
      confirmedQboPaymentId: "42",
    };
    // A reprocess recomputes the identical historical proposal — same
    // id, same fingerprint — so the decision survives untouched.
    await processStripePayoutLedger("po_abc");
    const rebuilt = proposals.get(moveId)!;
    assert.equal(rebuilt.status, "approved");
    assert.equal(
      (rebuilt.decision as { confirmedQboPaymentId?: string })
        .confirmedQboPaymentId,
      "42"
    );
    assert.equal(rebuilt.historical, true);
    assert.equal(rebuilt.autoEligible, false);
  });

  it("never auto-applies a historical proposal in automatic mode", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    accountingMode = "automatic";
    cutover = "2026-10-14"; // every line pre-cutover → all historical
    await processStripePayoutLedger("po_abc");
    // The automatic pass runs during processing but historical
    // proposals are manual-only: nothing is approved or applied, no QBO
    // writes happen.
    const proposals = [...collectionStore("qboAccountingProposals").values()];
    assert.ok(proposals.length > 0);
    for (const p of proposals) {
      assert.equal(p.historical, true);
      assert.equal(p.autoEligible, false);
      assert.equal(p.status, "proposed");
      assert.equal(p.decision, undefined);
    }
    assert.equal(applyCalls.length, 0);
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

describe("processStripePayoutLedger — Spreedly order identity", () => {
  // October 7 production fixture — payout po_1UNivbC2zsUcVaNLp8xawP3R:
  // an Ollie/Spreedly charge for $230.00 (metadata claims order 00326 /
  // payment ref 1623638) plus a $5.00 DDB website charge. Four UF
  // payments share the amount/date — only QBO Payment 1786 (Tropics
  // Cafe, refNum 1623638, linked invoice 00326) corroborates the claim.
  const PAYOUT_ID = "po_1UNivbC2zsUcVaNLp8xawP3R";
  const TXN_ID = "txn_3UNHoNC2zsUcVaNLl3PhIrt9";
  const CHARGE_ID = "ch_3UNHoNC2zsUcVaNL1iM9CMGQ";

  function payment1786(overrides: FakeDoc = {}): FakeDoc {
    return {
      id: "1786",
      txnDate: "2026-10-05",
      totalMinor: 23000,
      depositToAccountId: "uf-1",
      currency: "USD",
      customerName: "Tropics Cafe",
      refNumber: "1623638",
      linkedTxnIds: ["inv-326"],
      ...overrides,
    };
  }

  function seedOct7() {
    stripePayout = {
      id: PAYOUT_ID,
      status: "paid",
      amountMinor: 22413,
      currency: "USD",
      arrivalDate: "2026-10-07",
      createdMs: Date.parse("2026-10-06T00:00:00.000Z"),
    };
    payoutTxns = [
      {
        txnId: TXN_ID,
        type: "charge",
        grossMinor: 23000,
        feeMinor: 1042,
        netMinor: 21958,
        currency: "USD",
        sourceId: CHARGE_ID,
        // Pre-cutover → historical, manual-only.
        createdMs: Date.parse("2026-10-05T00:00:00.000Z"),
      },
      {
        txnId: "txn_ddb",
        type: "charge",
        grossMinor: 500,
        feeMinor: 45,
        netMinor: 455,
        currency: "USD",
        sourceId: "ch_ddb",
        createdMs: Date.parse("2026-10-05T00:00:00.000Z"),
      },
    ];
    cutover = "2026-10-09";
    collectionStore("payments").set("pay_ddb", {
      stripeChargeId: "ch_ddb",
    });
    chargeFacts.set(CHARGE_ID, {
      metadata: { connect_agent: "Spreedly", order_id: "00326-1623638" },
    });
    // Four same-amount UF payments — only 1786 carries both identifiers.
    const lookalike = (id: string, ref: string): FakeDoc => ({
      id,
      txnDate: "2026-10-05",
      totalMinor: 23000,
      depositToAccountId: "uf-1",
      currency: "USD",
      customerName: "Other Customer",
      refNumber: ref,
      linkedTxnIds: [`inv-${id}`],
    });
    qboPayments = [
      lookalike("1801", "9000001"),
      lookalike("1802", "9000002"),
      lookalike("1803", "9000003"),
      payment1786(),
    ];
    qboInvoices = [
      { id: "inv-326", docNumber: "00326" },
      { id: "inv-1801", docNumber: "00901" },
      { id: "inv-1802", docNumber: "00902" },
      { id: "inv-1803", docNumber: "00903" },
    ];
  }

  it("verifies QBO Payment 1786 out of four same-amount candidates", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    seedOct7();
    await processStripePayoutLedger(PAYOUT_ID);
    const doc = collectionStore("stripePayouts").get(PAYOUT_ID)!;
    const lines = doc.lines as FakeDoc[];
    const ollie = lines.find((l) => l.txnId === TXN_ID)!;
    const ddb = lines.find((l) => l.txnId === "txn_ddb")!;

    // The previously ambiguous charge is now a verified Ollie match on
    // the corroborated QBO internal id.
    assert.equal(ollie.lane, "ollie");
    assert.equal(ollie.confidence, "verified");
    assert.equal(ollie.qboPaymentId, "1786");
    assert.equal(ollie.reconciled, undefined);
    assert.ok(
      !(doc.exceptions as FakeDoc[]).some(
        (e) => e.ref === TXN_ID && e.code === "ambiguous_match"
      )
    );
    // The DDB website charge is unaffected by Ollie metadata.
    assert.equal(ddb.lane, "ddb");

    // A historical, manual-only move proposal references the internal
    // payment id — never the human-readable reference alone.
    const { qboProposalIdFor } = await import(
      "@/lib/stripe-payouts-common"
    );
    const moveId = qboProposalIdFor(
      "sandbox",
      PAYOUT_ID,
      "move_payment_to_clearing",
      "1786"
    );
    const move = collectionStore("qboAccountingProposals").get(moveId)!;
    assert.equal(move.kind, "move_payment_to_clearing");
    assert.equal(move.status, "proposed");
    assert.equal(move.historical, true);
    assert.notEqual(move.autoEligible, true);
    assert.equal(move.amountMinor, 23000);
    assert.equal(
      (move.qboRefs as { paymentId: string }).paymentId,
      "1786"
    );
    assert.equal(
      (move.debit as { accountId: string }).accountId,
      "34"
    );
    assert.equal(
      (move.credit as { accountId: string }).accountId,
      "uf-1"
    );

    // Fee + transfer aggregates still cover the whole payout.
    const kinds = [
      ...collectionStore("qboAccountingProposals").values(),
    ].map((p) => p.kind);
    assert.ok(kinds.includes("stripe_fee_expense"));
    assert.ok(kinds.includes("payout_transfer"));
  });

  it("rescues a claimed payment the date-window scan missed", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    seedOct7();
    // Payment 1786 predates the payout's UF scan window — the targeted
    // PaymentRefNum lookup finds it anyway.
    qboPayments = qboPayments.filter((p) => p.id !== "1786");
    qboRefNumPayments.set("1623638", [payment1786()]);
    await processStripePayoutLedger(PAYOUT_ID);
    const doc = collectionStore("stripePayouts").get(PAYOUT_ID)!;
    const line = (doc.lines as FakeDoc[]).find((l) => l.txnId === TXN_ID)!;
    assert.equal(line.lane, "ollie");
    assert.equal(line.confidence, "verified");
    assert.equal(line.qboPaymentId, "1786");
  });

  it("refuses a claimed payment that is not in Undeposited Funds", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    seedOct7();
    qboPayments = qboPayments.filter((p) => p.id !== "1786");
    // The lookup finds the payment — but it already deposits to a bank
    // account, so it is not a reclassification candidate. The claim
    // cannot be honored; the charge stays review-required.
    qboRefNumPayments.set("1623638", [
      payment1786({ depositToAccountId: "77" }),
    ]);
    await processStripePayoutLedger(PAYOUT_ID);
    const doc = collectionStore("stripePayouts").get(PAYOUT_ID)!;
    const line = (doc.lines as FakeDoc[]).find((l) => l.txnId === TXN_ID)!;
    assert.notEqual(line.qboPaymentId, "1786");
    assert.equal(line.lane, "external");
    assert.equal(line.confidence, "ambiguous");
    const moves = [
      ...collectionStore("qboAccountingProposals").values(),
    ].filter((p) => p.kind === "move_payment_to_clearing");
    assert.equal(moves.length, 0);
  });

  it("degrades to ambiguous when the Stripe charge read fails", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    seedOct7();
    chargeFactsErrors.add(CHARGE_ID);
    await processStripePayoutLedger(PAYOUT_ID);
    const doc = collectionStore("stripePayouts").get(PAYOUT_ID)!;
    const line = (doc.lines as FakeDoc[]).find((l) => l.txnId === TXN_ID)!;
    // No identity evidence → four same-amount candidates stay ambiguous.
    assert.equal(line.lane, "external");
    assert.equal(line.confidence, "ambiguous");
    const moves = [
      ...collectionStore("qboAccountingProposals").values(),
    ].filter((p) => p.kind === "move_payment_to_clearing");
    assert.equal(moves.length, 0);
  });

  it("still verifies through the fallback when Spreedly refs are absent", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    seedOct7();
    // Charge carries only the legacy labeled description.
    chargeFacts.set(CHARGE_ID, {
      description: "Ollie Order #00326",
    });
    await processStripePayoutLedger(PAYOUT_ID);
    const doc = collectionStore("stripePayouts").get(PAYOUT_ID)!;
    const line = (doc.lines as FakeDoc[]).find((l) => l.txnId === TXN_ID)!;
    // Order↔invoice identity hit disambiguates exactly as before.
    assert.equal(line.lane, "ollie");
    assert.equal(line.confidence, "verified");
    assert.equal(line.qboPaymentId, "1786");
  });
});

describe("processStripePayoutLedger — reconciled payment identity", () => {
  // Production regression fixture — payout po_1UPu2kC2zsUcVaNLpowu61JK
  // (2026-10-13, net $285.18): charge txn_3UOHlrC2zsUcVaNLOvs5Nk81 was
  // suggested-matched to QBO Payment 1795 (ref 1626166, Sea Saba,
  // $294.01 gross / $8.83 fee). The admin confirmed the identity and
  // all three historical proposals applied — Payment 1795 moved to
  // Stripe clearing, JE posted for the fee, transfer for the payout.
  // Reprocessing then dropped the line to External/unmatched because a
  // reclassified payment can never reappear in the UF candidate scan.
  const PAYOUT_ID = "po_1UPu2kC2zsUcVaNLpowu61JK";
  const TXN_ID = "txn_3UOHlrC2zsUcVaNLOvs5Nk81";
  const PAYMENT_ID = "1795";

  function seedOct13() {
    stripePayout = {
      id: PAYOUT_ID,
      status: "paid",
      amountMinor: 28518,
      currency: "USD",
      arrivalDate: "2026-10-13",
      createdMs: Date.parse("2026-10-13T00:00:00.000Z"),
    };
    payoutTxns = [
      {
        txnId: TXN_ID,
        type: "charge",
        grossMinor: 29401,
        feeMinor: 883,
        netMinor: 28518,
        currency: "USD",
        sourceId: "ch_sea_saba",
        // Source payment predates the production cutover — historical.
        createdMs: Date.parse("2026-10-08T00:00:00.000Z"),
      },
    ];
    cutover = "2026-10-09";
  }

  function qbo1795(overrides: FakeDoc = {}): FakeDoc {
    return {
      id: PAYMENT_ID,
      txnDate: "2026-10-08",
      totalMinor: 29401,
      depositToAccountId: "34", // Stripe clearing — post-move state
      currency: "USD",
      customerName: "Sea Saba",
      refNumber: "1626166",
      linkedTxnIds: [],
      ...overrides,
    };
  }

  async function moveProposalId(): Promise<string> {
    const { qboProposalIdFor } = await import(
      "@/lib/stripe-payouts-common"
    );
    return qboProposalIdFor(
      "sandbox",
      PAYOUT_ID,
      "move_payment_to_clearing",
      PAYMENT_ID
    );
  }

  function seedAppliedMove(): Promise<string> {
    return moveProposalId().then((moveId) => {
      collectionStore("qboAccountingProposals").set(moveId, {
        proposalId: moveId,
        environment: "sandbox",
        payoutId: PAYOUT_ID,
        kind: "move_payment_to_clearing",
        status: "applied",
        historical: true,
        lineConfidence: "suggested",
        amountMinor: 29401,
        currency: "USD",
        accountingDate: "2026-10-13",
        debit: { accountId: "34", label: "Stripe Clearing" },
        credit: { accountId: "uf-1", label: "Undeposited Funds" },
        stripeRefs: { payoutId: PAYOUT_ID, balanceTxnId: TXN_ID },
        qboRefs: { paymentId: PAYMENT_ID, paymentRef: "1626166" },
        decision: {
          action: "approved",
          confirmedQboPaymentId: PAYMENT_ID,
        },
        execution: {
          outcome: "applied",
          entityType: "Payment",
          entityId: PAYMENT_ID,
        },
        mode: "approval",
      });
      return moveId;
    });
  }

  function moveProposals(): FakeDoc[] {
    return [...collectionStore("qboAccountingProposals").values()].filter(
      (p) => p.kind === "move_payment_to_clearing"
    );
  }

  it("keeps the payment identified after the applied move — full lifecycle", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    seedOct13();
    // 1) Initial build — Payment 1795 still in Undeposited Funds.
    qboPayments = [qbo1795({ depositToAccountId: "uf-1" })];
    await processStripePayoutLedger(PAYOUT_ID);
    let doc = collectionStore("stripePayouts").get(PAYOUT_ID)!;
    let line = (doc.lines as FakeDoc[]).find((l) => l.txnId === TXN_ID)!;
    assert.equal(line.lane, "ollie");
    assert.equal(line.confidence, "suggested");
    assert.equal(line.reconciled, undefined);
    const moveId = await moveProposalId();
    const move = collectionStore("qboAccountingProposals").get(moveId)!;
    assert.equal(move.status, "proposed");
    assert.equal(move.historical, true);
    assert.equal(move.autoEligible, false);

    // 2) Admin confirms + executor applies all three proposals; the
    //    payment leaves UF for Stripe clearing.
    for (const p of collectionStore("qboAccountingProposals").values()) {
      p.status = "applied";
      p.execution = { outcome: "applied" };
    }
    qboPayments = [qbo1795()];
    qboPaymentsById.set(PAYMENT_ID, qbo1795());

    // 3) Reprocess — the durable applied record keeps the identity.
    await processStripePayoutLedger(PAYOUT_ID);
    doc = collectionStore("stripePayouts").get(PAYOUT_ID)!;
    line = (doc.lines as FakeDoc[]).find((l) => l.txnId === TXN_ID)!;
    assert.equal(line.lane, "ollie");
    assert.equal(line.confidence, "suggested"); // never upgraded
    assert.equal(line.reconciled, "applied");
    assert.equal(line.qboPaymentId, PAYMENT_ID);
    // cutover_skipped is expected for a pre-cutover line — what must be
    // absent is any match/conflict exception for the reconciled charge.
    for (const e of doc.exceptions as FakeDoc[]) {
      if (e.ref !== TXN_ID) continue;
      assert.notEqual(e.code, "unmatched_movement");
      assert.notEqual(e.code, "reconciled_state_conflict");
      assert.notEqual(e.code, "ambiguous_match");
    }

    // The applied move doc is untouched and remains the only move
    // proposal — no second executable reclassification is offered.
    const moves = moveProposals();
    assert.equal(moves.length, 1);
    assert.equal(moves[0].status, "applied");
    assert.equal(
      (moves[0].qboRefs as { paymentId: string }).paymentId,
      PAYMENT_ID
    );

    // JournalEntry (fee) and Transfer stay applied — no duplicates.
    const aggregates = [
      ...collectionStore("qboAccountingProposals").values(),
    ].filter((p) => p.kind !== "move_payment_to_clearing");
    assert.equal(aggregates.length, 2);
    for (const p of aggregates) assert.equal(p.status, "applied");
  });

  it("reports reconciled_state_conflict when the payment was deleted", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    seedOct13();
    const moveId = await seedAppliedMove();
    qboPayments = [];
    // No qboPaymentsById entry → live read returns null (deleted).
    await processStripePayoutLedger(PAYOUT_ID);
    const doc = collectionStore("stripePayouts").get(PAYOUT_ID)!;
    const line = (doc.lines as FakeDoc[]).find((l) => l.txnId === TXN_ID)!;
    // Fail closed: identity preserved for reporting, flagged conflict,
    // never silently rematched to an amount/date lookalike.
    assert.equal(line.lane, "ollie");
    assert.equal(line.reconciled, "conflict");
    const exc = (doc.exceptions as FakeDoc[]).find(
      (e) => e.ref === TXN_ID
    );
    assert.equal(exc?.code, "reconciled_state_conflict");
    const moves = moveProposals();
    assert.equal(moves.length, 1);
    assert.equal(moves[0].status, "applied");
    assert.ok(collectionStore("qboAccountingProposals").has(moveId));
  });

  it("reports conflict when amount, currency, or account contradict", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    const cases: { name: string; live: FakeDoc }[] = [
      { name: "amount changed", live: qbo1795({ totalMinor: 29500 }) },
      { name: "currency changed", live: qbo1795({ currency: "EUR" }) },
      {
        name: "back in Undeposited Funds",
        live: qbo1795({ depositToAccountId: "uf-1" }),
      },
      {
        name: "unexpected account",
        live: qbo1795({ depositToAccountId: "77" }),
      },
    ];
    for (const c of cases) {
      store.clear();
      seedOct13();
      await seedAppliedMove();
      qboPayments = [];
      qboPaymentsById.set(PAYMENT_ID, c.live);
      await processStripePayoutLedger(PAYOUT_ID);
      const doc = collectionStore("stripePayouts").get(PAYOUT_ID)!;
      const line = (doc.lines as FakeDoc[]).find(
        (l) => l.txnId === TXN_ID
      )!;
      assert.equal(line.reconciled, "conflict", c.name);
      assert.equal(line.lane, "ollie", c.name);
      const exc = (doc.exceptions as FakeDoc[]).find(
        (e) => e.ref === TXN_ID
      );
      assert.equal(exc?.code, "reconciled_state_conflict", c.name);
      assert.equal(moveProposals().length, 1, c.name);
    }
  });

  it("marks the line unverified, not unmatched, when live reads fail", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    seedOct13();
    await seedAppliedMove();
    qboPayments = [];
    qboPaymentFetchError = new Error("qbo outage");
    await processStripePayoutLedger(PAYOUT_ID);
    const doc = collectionStore("stripePayouts").get(PAYOUT_ID)!;
    const line = (doc.lines as FakeDoc[]).find((l) => l.txnId === TXN_ID)!;
    // An outage is not evidence: keep the identity, flag it unverified,
    // raise no conflict exception, propose nothing new.
    assert.equal(line.lane, "ollie");
    assert.equal(line.confidence, "suggested");
    assert.equal(line.reconciled, "unverified");
    assert.equal(line.qboPaymentId, PAYMENT_ID);
    assert.ok(
      !(doc.exceptions as FakeDoc[]).some(
        (e) => e.ref === TXN_ID && e.code !== "cutover_skipped"
      )
    );
    assert.equal(moveProposals().length, 1);
  });

  it("keeps genuine external activity unmatched alongside a reconciled line", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    seedOct13();
    await seedAppliedMove();
    qboPaymentsById.set(PAYMENT_ID, qbo1795());
    payoutTxns.push({
      txnId: "txn_external",
      type: "charge",
      grossMinor: 5000,
      feeMinor: 175,
      netMinor: 4825,
      currency: "USD",
      sourceId: "ch_other",
      createdMs: Date.parse("2026-10-12T00:00:00.000Z"),
    });
    stripePayout = { ...stripePayout!, amountMinor: 33343 };
    await processStripePayoutLedger(PAYOUT_ID);
    const doc = collectionStore("stripePayouts").get(PAYOUT_ID)!;
    const lines = doc.lines as FakeDoc[];
    const ollie = lines.find((l) => l.txnId === TXN_ID)!;
    const external = lines.find((l) => l.txnId === "txn_external")!;
    assert.equal(ollie.reconciled, "applied");
    assert.equal(external.lane, "external");
    assert.equal(external.confidence, "unmatched");
    assert.equal(external.reconciled, undefined);
    assert.ok(
      (doc.exceptions as FakeDoc[]).some(
        (e) => e.ref === "txn_external" && e.code === "unmatched_movement"
      )
    );
  });

  it("a reconciled historical line never becomes auto-executable", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    seedOct13();
    await seedAppliedMove();
    qboPaymentsById.set(PAYMENT_ID, qbo1795());
    accountingMode = "automatic";
    await processStripePayoutLedger(PAYOUT_ID);
    // No move proposal exists to execute, and the historical aggregates
    // are manual-only — automatic mode touches nothing.
    assert.equal(applyCalls.length, 0);
    for (const p of collectionStore("qboAccountingProposals").values()) {
      assert.notEqual(p.autoEligible, true);
    }
  });

  it("durable reconciliation wins over fresh Spreedly metadata", async () => {
    const { processStripePayoutLedger } = await import("@/lib/stripe-payouts");
    seedOct13();
    await seedAppliedMove();
    // The charge now also carries the Spreedly claim — the applied
    // proposal still owns the relationship; nothing re-matches and no
    // second move is proposed.
    chargeFacts.set("ch_sea_saba", {
      metadata: { connect_agent: "Spreedly", order_id: "00327-1626166" },
    });
    qboPaymentsById.set(PAYMENT_ID, qbo1795());
    await processStripePayoutLedger(PAYOUT_ID);
    const doc = collectionStore("stripePayouts").get(PAYOUT_ID)!;
    const line = (doc.lines as FakeDoc[]).find((l) => l.txnId === TXN_ID)!;
    assert.equal(line.lane, "ollie");
    assert.equal(line.confidence, "suggested"); // original tier preserved
    assert.equal(line.reconciled, "applied");
    assert.equal(line.qboPaymentId, PAYMENT_ID);
    const moves = moveProposals();
    assert.equal(moves.length, 1);
    assert.equal(moves[0].status, "applied");
  });
});

describe("processStripePayoutLedger — automatic mode", () => {
  function confirmCharge(): void {
    // DDB identity: the charge source resolves to a `payments` record.
    collectionStore("payments").set("pay_1", {
      stripeChargeId: "ch_ollie",
    });
  }

  function feeProposal(): [string, FakeDoc] {
    const entry = [
      ...collectionStore("qboAccountingProposals").entries(),
    ].find(([, data]) => data.kind === "stripe_fee_expense");
    assert.ok(entry, "expected a stripe_fee_expense proposal");
    return entry as [string, FakeDoc];
  }

  it("applies auto-eligible aggregates — the payout's own debit does not count against identity", async () => {
    confirmCharge();
    accountingMode = "automatic";
    payoutTxns = [
      { ...CHARGE },
      {
        txnId: "txn_po",
        type: "payout",
        grossMinor: -9680,
        feeMinor: 0,
        netMinor: -9680,
        currency: "USD",
        createdMs: Date.parse("2026-10-15T00:00:00.000Z"),
      },
    ];
    const { processStripePayoutLedger } = await import(
      "@/lib/stripe-payouts"
    );
    await processStripePayoutLedger("po_abc");
    // Fee and transfer aggregates both qualified for unattended apply.
    const [, fee] = feeProposal();
    assert.equal(fee.autoEligible, true);
    assert.ok(
      applyCalls.some((c) => c.proposalId === fee.proposalId && c.auto)
    );
    const stored = collectionStore("stripePayouts").get("po_abc")!;
    assert.equal(stored.pendingAutoApply, false);
  });

  it("persists a retry signal when an automatic apply fails, and a later sync revisits", async () => {
    confirmCharge();
    accountingMode = "automatic";
    applyOutcome = "failed";
    const { processStripePayoutLedger, syncStripePayouts } = await import(
      "@/lib/stripe-payouts"
    );
    await processStripePayoutLedger("po_abc");
    const callsAfterFirst = applyCalls.length;
    assert.ok(callsAfterFirst > 0);
    const stored = collectionStore("stripePayouts").get("po_abc")!;
    // The failure is durable — the ledger was stored as fully processed,
    // so only this flag keeps the payout in the recovery path.
    assert.equal(stored.pendingAutoApply, true);

    // A subsequent sync sees the payout as not-current and retries the
    // automatic applies.
    recentPayouts = [{ ...PAID_PAYOUT }];
    applyOutcome = "applied";
    const summary = await syncStripePayouts();
    assert.equal(summary.alreadyCurrent, 0);
    assert.equal(summary.processed, 1);
    assert.ok(applyCalls.length > callsAfterFirst);
    assert.equal(
      collectionStore("stripePayouts").get("po_abc")!.pendingAutoApply,
      false
    );
  });

  it("a thrown apply error also persists the retry signal", async () => {
    confirmCharge();
    accountingMode = "automatic";
    applyError = new Error("firestore unavailable");
    const { processStripePayoutLedger } = await import(
      "@/lib/stripe-payouts"
    );
    await processStripePayoutLedger("po_abc");
    assert.ok(applyCalls.length > 0);
    assert.equal(
      collectionStore("stripePayouts").get("po_abc")!.pendingAutoApply,
      true
    );
  });

  it("does not retry a refused apply — it needs a human", async () => {
    confirmCharge();
    accountingMode = "automatic";
    applyOutcome = "refused";
    const { processStripePayoutLedger } = await import(
      "@/lib/stripe-payouts"
    );
    await processStripePayoutLedger("po_abc");
    assert.ok(applyCalls.length > 0);
    assert.equal(
      collectionStore("stripePayouts").get("po_abc")!.pendingAutoApply,
      false
    );
  });

  it("invalidates an automation approval when unattended eligibility regresses", async () => {
    confirmCharge();
    const { processStripePayoutLedger } = await import(
      "@/lib/stripe-payouts"
    );
    await processStripePayoutLedger("po_abc");
    const [feeId, fee] = feeProposal();
    assert.equal(fee.autoEligible, true);
    // Simulate the decision the executor records when it auto-approves.
    collectionStore("qboAccountingProposals").set(feeId, {
      ...fee,
      status: "approved",
      decision: {
        action: "approve",
        actorUid: "automation",
        auto: true,
        at: new Date().toISOString(),
        fingerprint: fee.materialFingerprint,
      },
    });
    // Rebuild over a truncated ledger: same fee amount and fingerprint,
    // but the proposal no longer qualifies for unattended execution.
    payoutTxnsTruncated = true;
    await processStripePayoutLedger("po_abc");
    const after = collectionStore("qboAccountingProposals").get(feeId)!;
    assert.equal(after.autoEligible, false);
    assert.equal(after.status, "proposed");
    assert.equal(after.decision, undefined);
    assert.ok(
      (after.auditTrail as FakeDoc[]).some((e) =>
        (e.note as string).includes("no longer qualifies")
      )
    );
  });

  it("keeps a human approval binding the same material facts when eligibility regresses", async () => {
    confirmCharge();
    const { processStripePayoutLedger } = await import(
      "@/lib/stripe-payouts"
    );
    await processStripePayoutLedger("po_abc");
    const [feeId, fee] = feeProposal();
    collectionStore("qboAccountingProposals").set(feeId, {
      ...fee,
      status: "approved",
      decision: {
        action: "approve",
        actorUid: "admin-1",
        at: new Date().toISOString(),
        fingerprint: fee.materialFingerprint,
      },
    });
    payoutTxnsTruncated = true;
    await processStripePayoutLedger("po_abc");
    const after = collectionStore("qboAccountingProposals").get(feeId)!;
    // The material facts the human reviewed did not change — the
    // approval stands; only unattended eligibility is gone.
    assert.equal(after.status, "approved");
    assert.equal(after.autoEligible, false);
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

  it("marks a fully pre-cutover payout as ingested with manual-only proposals", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    cutover = "2026-10-14"; // charge movements are dated 2026-10-11
    const summary = await syncStripePayouts({ payoutId: "po_abc" });
    const item = summary.items[0];
    assert.equal(item.outcome, "processed");
    assert.equal(item.eligibleLines, 0);
    assert.equal(item.preCutoverLines, 1);
    // Historical proposals exist for manual reconciliation — move, fee,
    // transfer — all flagged historical and none auto-eligible.
    assert.equal(item.proposals, 3);
    assert.equal(summary.cutover, "2026-10-14");
    assert.equal(collectionStore("stripePayouts").has("po_abc"), true);
    const proposals = [...collectionStore("qboAccountingProposals").values()];
    assert.equal(proposals.length, 3);
    for (const p of proposals) {
      assert.equal(p.historical, true);
      assert.equal(p.autoEligible, false);
    }
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

  it("reports lease_lost — not failed — when a by-id sync loses the lock", async () => {
    const { syncStripePayouts } = await import("@/lib/stripe-payouts");
    // The TTL elapsed between fetch and processing; a successor owns the
    // lock now, so the payout is untouched and retryable — it must read
    // as remaining work, not a processing failure.
    onPayoutFetch = () => {
      collectionStore("qboSweepState").set("stripePayoutSync-sandbox", {
        environment: "sandbox",
        owner: "successor-run",
        leaseUntil: FakeTimestamp.fromMillis(Date.now() + 120_000),
      });
    };
    const summary = await syncStripePayouts({ payoutId: "po_abc" });
    assert.equal(summary.items[0].outcome, "lease_lost");
    assert.equal(summary.failed, 0);
    assert.equal(summary.remaining, 1);
    assert.equal(collectionStore("stripePayouts").has("po_abc"), false);
    const lease = collectionStore("qboSweepState").get(
      "stripePayoutSync-sandbox"
    )!;
    assert.equal(lease.owner, "successor-run");
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

describe("getStripePayoutAutomationView", () => {
  it("orders payouts by Stripe arrival date, newest first, with payout id as tie-breaker", async () => {
    // Seeded deliberately out of order — retrieval order (insertion
    // order through the fake) must not leak into the view.
    const seeded: [string, string][] = [
      ["po_mid", "2026-10-10"],
      ["po_new", "2026-10-14"],
      ["po_old", "2026-10-05"],
      ["po_same_b", "2026-10-14"],
      ["po_same_a", "2026-10-14"],
    ];
    for (const [id, arrivalDate] of seeded) {
      collectionStore("stripePayouts").set(id, {
        payoutId: id,
        environment: "sandbox",
        status: "paid",
        amountMinor: 1000,
        currency: "USD",
        arrivalDate,
        lastProcessedAt: FakeTimestamp.fromMillis(Date.now()),
      });
    }
    const { getStripePayoutAutomationView } = await import(
      "@/lib/stripe-payouts"
    );
    const view = await getStripePayoutAutomationView({});
    assert.deepEqual(
      view.payouts.map((p) => p.payoutId),
      ["po_same_b", "po_same_a", "po_new", "po_mid", "po_old"]
    );
  });
});
