import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { Timestamp } from "firebase-admin/firestore";
import { QboError } from "@/lib/qbo-errors";
import type { AdminActor } from "@/lib/admin-auth";
import {
  installQboDbMock,
  qboTokensMockExtras,
  withEnv,
} from "./qbo-test-helpers";

// Coverage for the issue #183 operations layer on top of the sync worker:
// bounded retry/backoff, the missed-enqueue sweep, authorization-loss
// pause/resume, the admin status view, and manual requeue — all at mocked
// provider boundaries (Stripe retrieve, QBO token/api, mapping).
//
// The clock is mocked with node:test timers so backoff scheduling is
// asserted exactly rather than with sleeps.

const firestore = installQboDbMock();

const state = {
  session: null as Record<string, unknown> | null,
  sessionError: null as unknown,
  mapping: {
    configured: true,
    mapping: {
      stripeClearingAccountId: "acct-stripe-balance",
      tourIncomeItemId: "item-tour",
      tastingIncomeItemId: "item-tasting",
      otherIncomeItemId: "item-other",
      fallbackCustomerId: "cust-generic",
    },
  } as { configured: boolean; mapping?: Record<string, string> },
  tokenError: null as unknown,
  foundReceipt: null as { id: string; correlationId?: string } | null,
  createResult: { id: "9001", correlationId: "tid-1" } as {
    id: string;
    correlationId?: string;
  },
  createError: null as unknown,
  createCalls: [] as Record<string, unknown>[],
  retrieveCalls: [] as string[],
};

const audits: Record<string, unknown>[] = [];

mock.module("@/lib/stripe", {
  namedExports: {
    getStripeClient: () => ({
      checkout: {
        sessions: {
          retrieve: async (id: string) => {
            state.retrieveCalls.push(id);
            if (state.sessionError) throw state.sessionError;
            return state.session;
          },
        },
      },
    }),
  },
});

mock.module("@/lib/qbo-tokens", {
  namedExports: {
    getQuickBooksAccessToken: async () => {
      if (state.tokenError) throw state.tokenError;
      return { accessToken: "at", realmId: "realm-prod" };
    },
    ...qboTokensMockExtras(firestore),
  },
});

mock.module("@/lib/qbo-mapping", {
  namedExports: {
    getQboMappingView: async () => state.mapping,
  },
});

mock.module("@/lib/qbo-api", {
  namedExports: {
    findQboSalesReceiptForMarker: async () => state.foundReceipt,
    createQboSalesReceipt: async (input: { payload: Record<string, unknown> }) => {
      state.createCalls.push(input.payload);
      if (state.createError) throw state.createError;
      return state.createResult;
    },
  },
});

mock.module("@/lib/admin-audit", {
  namedExports: {
    logAdminAudit: async (record: Record<string, unknown>) => {
      audits.push(record);
    },
  },
});

const ENV = { QBO_ENVIRONMENT: "sandbox" };
const RECORDS = "qboSyncRecords";
const PAYMENT_ID = "9f8e7d6c-1234-4abc-9def-0123456789ab";
const SYNC_ID = `sandbox:stripe_payment:${PAYMENT_ID}`;
const T0 = Date.parse("2026-02-10T12:00:00Z");

const CONNECTED = {
  status: "connected",
  realmId: "realm-prod",
  companyCountry: "CW",
  refreshTokenEnc: "enc-rt",
};

function paidPayment(overrides: Record<string, unknown> = {}) {
  return {
    status: "paid",
    purpose: "other",
    description: "QBO Test",
    amountMinor: 500,
    currency: "usd",
    customerName: "Chad Nuttall",
    stripeCheckoutSessionId: "cs_test_1",
    stripePaymentIntentId: "pi_1",
    stripeChargeId: "ch_1",
    // Real Timestamp — production stores paidAt as a Firestore
    // timestamp and the sweep's window filter depends on it.
    paidAt: Timestamp.fromMillis(T0 - 60 * 60 * 1000),
    ...overrides,
  };
}

function paidSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_1",
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    amount_total: 500,
    currency: "usd",
    payment_intent: "pi_1",
    metadata: { paymentId: PAYMENT_ID },
    client_reference_id: PAYMENT_ID,
    ...overrides,
  };
}

function reset(seed: Record<string, Record<string, unknown>> = {}) {
  firestore.reset({
    "qboConnections/sandbox": { ...CONNECTED },
    ...seed,
  });
  state.session = paidSession();
  state.sessionError = null;
  state.mapping = {
    configured: true,
    mapping: {
      stripeClearingAccountId: "acct-stripe-balance",
      tourIncomeItemId: "item-tour",
      tastingIncomeItemId: "item-tasting",
      otherIncomeItemId: "item-other",
      fallbackCustomerId: "cust-generic",
    },
  };
  state.tokenError = null;
  state.foundReceipt = null;
  state.createResult = { id: "9001", correlationId: "tid-1" };
  state.createError = null;
  state.createCalls = [];
  state.retrieveCalls = [];
  audits.length = 0;
}

async function process(syncId: string) {
  const { processQboSyncRecord } = await import("@/lib/qbo-sync");
  return withEnv(ENV, () => processQboSyncRecord(syncId));
}

async function sweep(nowMs: number) {
  const { runQboSyncSweep } = await import("@/lib/qbo-sweep");
  return withEnv(ENV, () => runQboSyncSweep(nowMs));
}

async function resume() {
  const { resumeQboSyncAfterReconnect } = await import("@/lib/qbo-sweep");
  return withEnv(ENV, () => resumeQboSyncAfterReconnect("sandbox"));
}

async function adminView() {
  const { getQboSyncAdminView } = await import("@/lib/qbo-sync-admin");
  return withEnv(ENV, () => getQboSyncAdminView());
}

const ACTOR = {
  token: { uid: "admin-1", email: "admin@example.test" },
  claims: { admin: true, role: "admin" },
  record: {
    uid: "admin-1",
    email: "admin@example.test",
    role: "admin",
    status: "active",
  },
} as unknown as AdminActor;

async function requeue(syncId: string) {
  const { requeueQboSyncRecord } = await import("@/lib/qbo-sync-admin");
  return withEnv(ENV, () => requeueQboSyncRecord(ACTOR, syncId));
}

function syncDoc(syncId = SYNC_ID) {
  return firestore.docs.get(`${RECORDS}/${syncId}`);
}

function pendingRecord(overrides: Record<string, unknown> = {}) {
  const environment = (overrides.environment as string) ?? "sandbox";
  const sourceId = (overrides.sourceId as string) ?? PAYMENT_ID;
  return {
    // Mirrors buildQboSyncRecordDoc: syncId duplicates the document id
    // and createdAt/updatedAt are written at creation — ordered queries
    // exclude documents missing the ordered field.
    syncId: `${environment}:stripe_payment:${sourceId}`,
    sourceType: "stripe_payment",
    sourceId,
    status: "pending",
    environment,
    attempts: 0,
    nextAttemptAt: null,
    createdAt: Timestamp.fromMillis(T0 - 60 * 1000),
    updatedAt: Timestamp.fromMillis(T0),
    ...overrides,
  };
}

describe("retry policy — backoff and bounds (#183)", () => {
  it("schedules the first retry after a transient failure", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: pendingRecord(),
    });
    state.createError = new QboError("down", "unavailable", 502);

    mock.timers.enable({ apis: ["Date"], now: T0 });
    try {
      const result = await process(SYNC_ID);
      assert.strictEqual(result.outcome, "failed");
      const doc = syncDoc();
      assert.strictEqual(doc?.status, "failed");
      assert.strictEqual(doc?.attempts, 1);
      assert.strictEqual(doc?.lastErrorCode, "unavailable");
      // Attempt 1 → 1-minute delay.
      assert.strictEqual(
        (doc?.nextAttemptAt as Timestamp).toMillis(),
        T0 + 60 * 1000
      );
    } finally {
      mock.timers.reset();
    }
  });

  it("progresses through the backoff table and is deferred until due", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: pendingRecord(),
    });
    state.createError = new QboError("down", "unavailable", 502);

    mock.timers.enable({ apis: ["Date"], now: T0 });
    try {
      await process(SYNC_ID);

      // Before the scheduled time the worker refuses to claim it.
      mock.timers.tick(30 * 1000);
      const early = await process(SYNC_ID);
      assert.strictEqual(early.outcome, "deferred");
      assert.strictEqual(syncDoc()?.attempts, 1);
      assert.strictEqual(state.createCalls.length, 1);

      // Once due, the second failure schedules the 5-minute delay.
      mock.timers.tick(31 * 1000);
      const second = await process(SYNC_ID);
      assert.strictEqual(second.outcome, "failed");
      const doc = syncDoc();
      assert.strictEqual(doc?.attempts, 2);
      assert.strictEqual(
        (doc?.nextAttemptAt as Timestamp).toMillis(),
        T0 + 61 * 1000 + 5 * 60 * 1000
      );
    } finally {
      mock.timers.reset();
    }
  });

  it("parks in needs_attention once the attempt budget is spent", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: pendingRecord({ attempts: 7 }),
    });
    state.createError = new QboError("down", "unavailable", 502);

    const result = await process(SYNC_ID);
    // Reported outcome matches the parked record, not the last error.
    assert.strictEqual(result.outcome, "needs_attention");
    assert.strictEqual(
      result.outcome === "needs_attention" ? result.reason : undefined,
      "retry_exhausted"
    );

    const doc = syncDoc();
    assert.strictEqual(doc?.attempts, 8);
    assert.strictEqual(doc?.status, "needs_attention");
    assert.strictEqual(doc?.lastErrorCode, "retry_exhausted");
    assert.strictEqual(doc?.nextAttemptAt, null);

    // A parked record is never picked up again by the worker.
    const again = await process(SYNC_ID);
    assert.strictEqual(again.outcome, "needs_attention");
    assert.strictEqual(state.createCalls.length, 8 - 7);
  });

  it("a stale syncing lease is reclaimed even with a future nextAttemptAt", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: pendingRecord({
        status: "syncing",
        attempts: 1,
        // The crashed claimant's retry schedule must not block recovery.
        nextAttemptAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
        syncingLeaseUntil: Timestamp.fromMillis(Date.now() - 1000),
      }),
    });
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "synced");
    assert.strictEqual(syncDoc()?.status, "synced");
    assert.strictEqual(state.createCalls.length, 1);
  });
});

describe("authorization loss — pause and resume (#183)", () => {
  it("pauses without claiming when the connection needs reauthorization", async () => {
    reset({
      "qboConnections/sandbox": {
        ...CONNECTED,
        status: "reauthorization_required",
      },
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: pendingRecord(),
    });
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "paused");

    // Untouched: no attempt consumed, no provider calls, still pending.
    const doc = syncDoc();
    assert.strictEqual(doc?.status, "pending");
    assert.strictEqual(doc?.attempts, 0);
    assert.strictEqual(state.retrieveCalls.length, 0);
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("records a failed authorization_expired attempt the resume hook can accelerate", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: pendingRecord(),
    });
    state.tokenError = new QboError(
      "QuickBooks authorization needs to be renewed.",
      "authorization_expired",
      409
    );
    mock.timers.enable({ apis: ["Date"], now: T0 });
    try {
      const first = await process(SYNC_ID);
      assert.strictEqual(first.outcome, "failed");
      assert.strictEqual(
        syncDoc()?.lastErrorCode,
        "authorization_expired"
      );

      // Reconnect succeeds; the resume hook pulls the record forward.
      state.tokenError = null;
      firestore.docs.set("qboConnections/sandbox", { ...CONNECTED });
      const resumed = await resume();
      assert.strictEqual(resumed, 1);
      const due = (syncDoc()?.nextAttemptAt as Timestamp).toMillis();
      assert.ok(due <= T0 + 60 * 1000, "record should be due immediately");

      const second = await process(SYNC_ID);
      assert.strictEqual(second.outcome, "synced");
      assert.strictEqual(syncDoc()?.status, "synced");
    } finally {
      mock.timers.reset();
    }
  });
});

describe("runQboSyncSweep — missed enqueues and due records (#183)", () => {
  it("enqueues and posts a settled payment that has no sync record", async () => {
    reset({ [`payments/${PAYMENT_ID}`]: paidPayment() });
    const summary = await sweep(T0);

    assert.strictEqual(summary.paused, false);
    assert.strictEqual(summary.paymentsScanned, 1);
    assert.strictEqual(summary.enqueued, 1);
    assert.strictEqual(summary.processed, 1);
    assert.strictEqual(summary.outcomes.synced, 1);
    assert.strictEqual(state.createCalls.length, 1);
    assert.strictEqual(syncDoc()?.status, "synced");
  });

  it("ignores payments older than the lookback window — no backfill", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment({
        paidAt: Timestamp.fromMillis(T0 - 10 * 24 * 60 * 60 * 1000),
      }),
    });
    const summary = await sweep(T0);
    assert.strictEqual(summary.paymentsScanned, 0);
    assert.strictEqual(summary.enqueued, 0);
    assert.strictEqual(syncDoc(), undefined);
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("never enqueues non-settled or foreign activity", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment({ status: "awaiting_payment" }),
      // A second settled payment with an existing synced record.
      "payments/other-paid": paidPayment({ status: "paid" }),
      [`${RECORDS}/sandbox:stripe_payment:other-paid`]: {
        syncId: "sandbox:stripe_payment:other-paid",
        sourceType: "stripe_payment",
        sourceId: "other-paid",
        status: "synced",
        environment: "sandbox",
        qboEntityId: "777",
        updatedAt: Timestamp.fromMillis(T0),
      },
    });
    const summary = await sweep(T0);
    assert.strictEqual(summary.paymentsScanned, 2);
    assert.strictEqual(summary.enqueued, 0, "unsettled + already recorded");
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("drains a due failed record and leaves a deferred one alone", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: pendingRecord({
        status: "failed",
        attempts: 1,
        nextAttemptAt: Timestamp.fromMillis(T0 - 1000),
      }),
      "payments/deferred-payment": paidPayment(),
      [`${RECORDS}/sandbox:stripe_payment:deferred-payment`]: {
        syncId: "sandbox:stripe_payment:deferred-payment",
        sourceType: "stripe_payment",
        sourceId: "deferred-payment",
        status: "failed",
        environment: "sandbox",
        attempts: 1,
        nextAttemptAt: Timestamp.fromMillis(T0 + 60 * 60 * 1000),
        updatedAt: Timestamp.fromMillis(T0),
      },
    });
    // The deferred record's payment needs a matching session; only the
    // due one is processed so the default session suffices.
    const summary = await sweep(T0);
    assert.strictEqual(summary.processed, 1);
    assert.strictEqual(summary.outcomes.synced, 1);
    const deferred = syncDoc("sandbox:stripe_payment:deferred-payment");
    assert.strictEqual(deferred?.status, "failed");
    assert.strictEqual(deferred?.attempts, 1);
  });

  it("reclaims a record whose worker crashed past its claim lease", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: pendingRecord({
        status: "syncing",
        attempts: 1,
        syncingLeaseUntil: Timestamp.fromMillis(T0 - 60 * 1000),
      }),
    });
    const summary = await sweep(T0);
    assert.strictEqual(summary.outcomes.synced, 1);
    assert.strictEqual(syncDoc()?.status, "synced");
  });

  it("rotates the 500-record scan page so a due record behind it still runs", async () => {
    // A full page of matching-but-not-due records whose ids sort ahead
    // of SYNC_ID ("0-…" < "9f…") — without page rotation the due record
    // would sit beyond the scan limit on every run.
    const seed: Record<string, Record<string, unknown>> = {
      [`payments/${PAYMENT_ID}`]: paidPayment(),
    };
    for (let i = 0; i < 500; i++) {
      const blocker = `0-blocker-${String(i).padStart(4, "0")}`;
      seed[`${RECORDS}/sandbox:stripe_payment:${blocker}`] = pendingRecord({
        sourceId: blocker,
        status: "failed",
        attempts: 1,
        nextAttemptAt: Timestamp.fromMillis(T0 + 60 * 60 * 1000),
      });
    }
    seed[`${RECORDS}/${SYNC_ID}`] = pendingRecord();
    reset(seed);

    const first = await sweep(T0);
    assert.strictEqual(first.processed, 0, "page 1 holds only blockers");
    assert.strictEqual(
      firestore.docs.get("qboSweepState/sandbox")?.lastSyncId,
      "sandbox:stripe_payment:0-blocker-0499"
    );

    const second = await sweep(T0);
    assert.strictEqual(second.processed, 1);
    assert.strictEqual(second.outcomes.synced, 1);
    assert.strictEqual(syncDoc()?.status, "synced");
    // The short page wraps the cursor so the next run starts over.
    assert.strictEqual(
      firestore.docs.get("qboSweepState/sandbox")?.lastSyncId,
      null
    );
  });

  it("reports paused and preserves work when authorization is invalid", async () => {
    reset({
      "qboConnections/sandbox": {
        ...CONNECTED,
        status: "reauthorization_required",
      },
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: pendingRecord({ attempts: 2 }),
    });
    const summary = await sweep(T0);
    assert.strictEqual(summary.paused, true);
    // Enqueue intent still lands; nothing is attempted.
    assert.strictEqual(summary.enqueued, 0);
    assert.strictEqual(summary.processed, 0);
    assert.strictEqual(syncDoc()?.status, "pending");
    assert.strictEqual(syncDoc()?.attempts, 2);
    assert.strictEqual(state.createCalls.length, 0);
  });
});

describe("admin sync view (#183)", () => {
  it("reports counts by status plus only the problem records", async () => {
    reset({
      [`${RECORDS}/sandbox:stripe_payment:a`]: pendingRecord({
        sourceId: "a",
      }),
      [`${RECORDS}/sandbox:stripe_payment:b`]: pendingRecord({
        sourceId: "b",
        status: "synced",
        qboEntityId: "9001",
      }),
      [`${RECORDS}/sandbox:stripe_payment:c`]: pendingRecord({
        sourceId: "c",
        status: "failed",
        attempts: 3,
        lastErrorCode: "unavailable",
        lastErrorMessage: "QuickBooks is temporarily unavailable.",
        nextAttemptAt: Timestamp.fromMillis(T0 + 60 * 1000),
        lastAttemptAt: Timestamp.fromMillis(T0 - 60 * 1000),
        updatedAt: Timestamp.fromMillis(T0 - 30 * 1000),
      }),
      [`${RECORDS}/sandbox:stripe_payment:d`]: pendingRecord({
        sourceId: "d",
        status: "needs_attention",
        attempts: 8,
        lastErrorCode: "retry_exhausted",
        updatedAt: Timestamp.fromMillis(T0 - 20 * 1000),
      }),
      // A record from the other environment never leaks into the view.
      [`${RECORDS}/production:stripe_payment:x`]: pendingRecord({
        sourceId: "x",
        environment: "production",
        status: "failed",
      }),
      // Secrets/PII on the stored record must not reach the view.
      [`${RECORDS}/sandbox:stripe_payment:e`]: pendingRecord({
        sourceId: "e",
        status: "failed",
        lastErrorCode: "validation",
        candidate: { customerEmail: "buyer@example.test" },
        updatedAt: Timestamp.fromMillis(T0 - 10 * 1000),
      }),
    });

    const view = await adminView();
    assert.strictEqual(view.paused, false);
    assert.deepStrictEqual(view.counts, {
      pending: 1,
      syncing: 0,
      synced: 1,
      failed: 2,
      needs_attention: 1,
    });
    // Only the sandbox problem records, ordered newest activity first
    // by `updatedAt` server-side.
    const ids = view.records.map((r) => r.sourceId);
    assert.deepStrictEqual(ids, ["e", "d", "c"]);
    const recordE = view.records.find((r) => r.sourceId === "e");
    assert.ok(recordE);
    assert.strictEqual(
      JSON.stringify(recordE).includes("buyer@example.test"),
      false,
      "candidate payload / PII must not be serialized"
    );
  });

  it("surfaces paused when the connection needs reauthorization", async () => {
    reset({
      "qboConnections/sandbox": {
        ...CONNECTED,
        status: "reauthorization_required",
      },
    });
    const view = await adminView();
    assert.strictEqual(view.paused, true);
  });
});

describe("manual retry (#183)", () => {
  it("requeues a needs_attention record and processes it inline", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: pendingRecord({
        status: "needs_attention",
        attempts: 8,
        lastErrorCode: "retry_exhausted",
      }),
    });
    const result = await requeue(SYNC_ID);
    assert.strictEqual(result.outcome, "synced");
    assert.strictEqual(result.qboEntityId, "9001");
    assert.strictEqual(syncDoc()?.status, "synced");
    assert.strictEqual(state.createCalls.length, 1);

    // The requeue was audited.
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].action, "qbo_sync_requeued");
    assert.strictEqual(audits[0].actingUid, "admin-1");
  });

  it("requeues a failed record with a fresh attempt budget", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: pendingRecord({
        status: "failed",
        attempts: 4,
        nextAttemptAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
      }),
    });
    state.createError = new QboError("still down", "unavailable", 502);
    const result = await requeue(SYNC_ID);
    assert.strictEqual(result.outcome, "failed");
    // A fresh budget: back to attempt 1, rescheduled — not still parked.
    assert.strictEqual(syncDoc()?.attempts, 1);
    assert.strictEqual(syncDoc()?.status, "failed");
  });

  it("rejects records that are not failed/needs_attention", async () => {
    reset({
      [`${RECORDS}/${SYNC_ID}`]: pendingRecord({ status: "synced" }),
    });
    await assert.rejects(requeue(SYNC_ID), (error: unknown) => {
      assert.ok(error instanceof QboError);
      assert.strictEqual((error as QboError).status, 409);
      return true;
    });
    assert.strictEqual(syncDoc()?.status, "synced");
  });

  it("rejects a record from another environment", async () => {
    reset({
      [`${RECORDS}/production:stripe_payment:x`]: pendingRecord({
        sourceId: "x",
        environment: "production",
        status: "failed",
      }),
    });
    await assert.rejects(
      requeue("production:stripe_payment:x"),
      (error: unknown) => {
        assert.ok(error instanceof QboError);
        assert.strictEqual((error as QboError).status, 409);
        return true;
      }
    );
  });

  it("rejects an unknown sync id", async () => {
    reset();
    await assert.rejects(requeue("sandbox:stripe_payment:nope"), {
      status: 404,
    });
  });
});
