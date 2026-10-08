import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { Timestamp } from "firebase-admin/firestore";
import { QboError } from "@/lib/qbo-errors";
import { installQboDbMock, withEnv } from "./qbo-test-helpers";

// --- Shared mock state (reset per test) ---

const firestore = installQboDbMock();

const state = {
  // Stripe session the canonical fetch returns (or throws).
  session: null as Record<string, unknown> | null,
  sessionError: null as unknown,
  // Mapping view the worker sees.
  mapping: {
    configured: true,
    mapping: {
      stripeClearingAccountId: "acct-stripe-balance",
      tourIncomeItemId: "item-tour",
      tastingIncomeItemId: "item-tasting",
      otherIncomeItemId: "item-other",
      fallbackCustomerId: "cust-generic",
    },
  } as {
    configured: boolean;
    mapping?: Record<string, string>;
    missingFields?: string[];
  },
  tokenError: null as unknown,
  // Provider-side recovery lookup result.
  foundReceipt: null as { id: string; correlationId?: string } | null,
  findError: null as unknown,
  createResult: { id: "9001", correlationId: "tid-1" } as {
    id: string;
    correlationId?: string;
  },
  createError: null as unknown,
  createCalls: [] as Record<string, unknown>[],
  retrieveCalls: [] as string[],
  // Milliseconds the canonical Stripe retrieve "consumes" — tests advance
  // the mocked clock by this much to exercise the claim-lease fence.
  retrieveDelayMs: 0,
};

mock.module("@/lib/stripe", {
  namedExports: {
    getStripeClient: () => ({
      checkout: {
        sessions: {
          retrieve: async (id: string) => {
            state.retrieveCalls.push(id);
            if (state.retrieveDelayMs) mock.timers.tick(state.retrieveDelayMs);
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
  },
});

mock.module("@/lib/qbo-mapping", {
  namedExports: {
    getQboMappingView: async () => state.mapping,
  },
});

mock.module("@/lib/qbo-api", {
  namedExports: {
    findQboSalesReceiptForMarker: async () => {
      if (state.findError) throw state.findError;
      return state.foundReceipt;
    },
    createQboSalesReceipt: async (input: { payload: Record<string, unknown> }) => {
      state.createCalls.push(input.payload);
      if (state.createError) throw state.createError;
      return state.createResult;
    },
  },
});

const ENV = { QBO_ENVIRONMENT: "sandbox" };
const RECORDS = "qboSyncRecords";
const PAYMENT_ID = "9f8e7d6c-1234-4abc-9def-0123456789ab";
const SYNC_ID = `sandbox:stripe_payment:${PAYMENT_ID}`;

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
    paidAt: "2026-02-05T14:30:00Z",
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
    "qboConnections/sandbox": {
      status: "connected",
      realmId: "realm-prod",
      companyCountry: "CW",
    },
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
  state.findError = null;
  state.createResult = { id: "9001", correlationId: "tid-1" };
  state.createError = null;
  state.createCalls = [];
  state.retrieveCalls = [];
  state.retrieveDelayMs = 0;
}

async function post(paymentId: string) {
  const { postPaidPaymentToQbo } = await import("@/lib/qbo-sync");
  return withEnv(ENV, () => postPaidPaymentToQbo(paymentId));
}

async function process(syncId: string) {
  const { processQboSyncRecord } = await import("@/lib/qbo-sync");
  return withEnv(ENV, () => processQboSyncRecord(syncId));
}

function syncDoc() {
  return firestore.docs.get(`${RECORDS}/${SYNC_ID}`);
}

describe("postPaidPaymentToQbo — source identity", () => {
  it("posts one Sales Receipt for a settled DDB payment", async () => {
    reset({ [`payments/${PAYMENT_ID}`]: paidPayment() });
    await post(PAYMENT_ID);

    assert.strictEqual(state.createCalls.length, 1);
    const payload = state.createCalls[0];
    const line = (payload.Line as Record<string, unknown>[])[0];
    assert.strictEqual(line.Amount, 5);
    assert.deepStrictEqual(payload.DepositToAccountRef, {
      value: "acct-stripe-balance",
    });
    assert.deepStrictEqual(payload.CustomerRef, { value: "cust-generic" });
    assert.deepStrictEqual(
      (line.SalesItemLineDetail as Record<string, unknown>).ItemRef,
      { value: "item-other" }
    );
    // Non-US (CW) company → explicit non-tax calculation, never US semantics.
    assert.strictEqual(payload.GlobalTaxCalculation, "NotApplicable");
    assert.strictEqual(payload.TxnDate, "2026-02-05");
    assert.ok((payload.PrivateNote as string).includes(`ddb:${PAYMENT_ID}`));

    const doc = syncDoc();
    assert.strictEqual(doc?.status, "synced");
    assert.strictEqual(doc?.qboEntityType, "SalesReceipt");
    assert.strictEqual(doc?.qboEntityId, "9001");
    assert.strictEqual(doc?.realmId, "realm-prod");
  });

  it("maps every payment purpose to the canonical income item", async () => {
    // The §6 purpose→item table (#182): tour-family purposes share the
    // tour item; tasting and other get their own.
    const cases = [
      ["brewery_tour", "item-tour"],
      ["additional_guests", "item-tour"],
      ["private_tour", "item-tour"],
      ["brewery_tour_tasting", "item-tasting"],
      ["other", "item-other"],
    ] as const;
    for (const [purpose, itemId] of cases) {
      reset({ [`payments/${PAYMENT_ID}`]: paidPayment({ purpose }) });
      await post(PAYMENT_ID);
      const detail = (state.createCalls[0].Line as Record<string, unknown>[])[0]
        .SalesItemLineDetail as Record<string, unknown>;
      assert.deepStrictEqual(detail.ItemRef, { value: itemId }, purpose);
    }
  });

  it("never enqueues non-DDB activity — a Stripe charge with no payments record", async () => {
    reset(); // No payments/<id> document — an Ollie/Spreedly charge looks exactly like this.
    await post("some-foreign-charge");
    assert.strictEqual(state.createCalls.length, 0);
    assert.strictEqual(firestore.docs.has(`${RECORDS}/sandbox:stripe_payment:some-foreign-charge`), false);
  });

  it("skips a record that exists but has not settled", async () => {
    reset({ [`payments/${PAYMENT_ID}`]: paidPayment({ status: "awaiting_payment" }) });
    await post(PAYMENT_ID);
    assert.strictEqual(state.createCalls.length, 0);
    assert.strictEqual(syncDoc(), undefined);
  });

  it("marks needs_attention when the canonical session belongs to a different payment", async () => {
    reset({ [`payments/${PAYMENT_ID}`]: paidPayment() });
    state.session = paidSession({ metadata: { paymentId: "other-id" }, client_reference_id: "other-id" });
    firestore.reset({
      "qboConnections/sandbox": { status: "connected", realmId: "realm-prod", companyCountry: "CW" },
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: {
        sourceType: "stripe_payment",
        sourceId: PAYMENT_ID,
        status: "pending",
      },
    });
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "needs_attention");
    assert.strictEqual(syncDoc()?.lastErrorCode, "identity_mismatch");
    assert.strictEqual(state.createCalls.length, 0);
  });
});

describe("processQboSyncRecord — idempotency and concurrency", () => {
  it("creates no second receipt for a replayed trigger", async () => {
    reset({ [`payments/${PAYMENT_ID}`]: paidPayment() });
    await post(PAYMENT_ID);
    await post(PAYMENT_ID); // webhook replay / manual retry
    assert.strictEqual(state.createCalls.length, 1);
    assert.strictEqual(syncDoc()?.status, "synced");
  });

  it("returns already_synced without provider calls for a synced record", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: {
        sourceType: "stripe_payment",
        sourceId: PAYMENT_ID,
        status: "synced",
        qboEntityId: "777",
      },
    });
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "already_synced");
    assert.strictEqual(state.retrieveCalls.length, 0);
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("does not double-post when a fresh claim is already in progress", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      [`${RECORDS}/${SYNC_ID}`]: {
        sourceType: "stripe_payment",
        sourceId: PAYMENT_ID,
        status: "syncing",
        syncingLeaseUntil: Timestamp.fromMillis(Date.now() + 60_000),
      },
    });
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "in_progress");
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("adopts a receipt that landed but whose response was lost", async () => {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(),
      // A stale claim — the previous worker died after the QBO write.
      [`${RECORDS}/${SYNC_ID}`]: {
        sourceType: "stripe_payment",
        sourceId: PAYMENT_ID,
        status: "syncing",
        syncingLeaseUntil: Timestamp.fromMillis(Date.now() - 60_000),
      },
    });
    state.foundReceipt = { id: "5550", correlationId: "tid-lookup" };
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "synced");
    assert.strictEqual(state.createCalls.length, 0, "must not create a duplicate");
    assert.strictEqual(syncDoc()?.qboEntityId, "5550");
    assert.strictEqual(syncDoc()?.status, "synced");
  });
});

describe("processQboSyncRecord — gates and failures", () => {
  function seedPending(paymentOverrides: Record<string, unknown> = {}) {
    reset({
      [`payments/${PAYMENT_ID}`]: paidPayment(paymentOverrides),
      [`${RECORDS}/${SYNC_ID}`]: {
        sourceType: "stripe_payment",
        sourceId: PAYMENT_ID,
        status: "pending",
      },
    });
  }

  it("fails closed when accounting mapping is not configured", async () => {
    seedPending();
    state.mapping = { configured: false };
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "needs_attention");
    assert.strictEqual(syncDoc()?.lastErrorCode, "mapping_unconfigured");
    assert.strictEqual(state.createCalls.length, 0);
    assert.strictEqual(state.retrieveCalls.length, 0, "no Stripe call before the gate");
  });

  it("fails closed when the stored mapping is incomplete — even for fields this payment does not need", async () => {
    // Legacy/incomplete document: every required field this payment
    // (purpose "other") needs is present, but the mapping as a whole is
    // unfinished — nothing may post until it is complete.
    seedPending();
    state.mapping = {
      configured: true,
      mapping: {
        stripeClearingAccountId: "acct-stripe-balance",
        otherIncomeItemId: "item-other",
        fallbackCustomerId: "cust-generic",
      },
      missingFields: ["tourIncomeItemId", "tastingIncomeItemId"],
    };
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "needs_attention");
    assert.strictEqual(syncDoc()?.lastErrorCode, "mapping_incomplete");
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("fails closed when a required mapping field is missing", async () => {
    // Per-field check below the completeness gate — a view without
    // missingFields exercises it directly.
    seedPending();
    state.mapping = {
      configured: true,
      mapping: { fallbackCustomerId: "cust-generic", otherIncomeItemId: "item-other" },
    };
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "needs_attention");
    assert.strictEqual(syncDoc()?.lastErrorCode, "missing_stripeClearingAccountId");
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("fails closed when the payment's purpose has no item mapping", async () => {
    seedPending({ purpose: "gift_card" });
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "needs_attention");
    assert.strictEqual(syncDoc()?.lastErrorCode, "purpose_unmapped");
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("guards the per-item invariant when a complete-looking view lacks the field", async () => {
    // Defensive branch: a real view always carries missingFields, so
    // this state is only reachable if the completeness flag disagrees
    // with the mapping — the check keeps it fail-closed regardless.
    seedPending({ purpose: "brewery_tour_tasting" });
    state.mapping = {
      configured: true,
      missingFields: [],
      mapping: {
        stripeClearingAccountId: "acct-stripe-balance",
        tourIncomeItemId: "item-tour",
        otherIncomeItemId: "item-other",
        fallbackCustomerId: "cust-generic",
      },
    };
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "needs_attention");
    assert.strictEqual(syncDoc()?.lastErrorCode, "missing_incomeItem");
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("fails closed when the generic sales customer is unmapped", async () => {
    seedPending();
    state.mapping = {
      configured: true,
      mapping: {
        stripeClearingAccountId: "acct-stripe-balance",
        tourIncomeItemId: "item-tour",
        tastingIncomeItemId: "item-tasting",
        otherIncomeItemId: "item-other",
      },
    };
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "needs_attention");
    assert.strictEqual(syncDoc()?.lastErrorCode, "missing_fallbackCustomerId");
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("marks missing payment records for attention without any provider write", async () => {
    reset({
      [`${RECORDS}/${SYNC_ID}`]: {
        sourceType: "stripe_payment",
        sourceId: PAYMENT_ID,
        status: "pending",
      },
    });
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "needs_attention");
    assert.strictEqual(syncDoc()?.lastErrorCode, "payment_missing");
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("marks an unsettled canonical session for attention", async () => {
    seedPending();
    state.session = paidSession({ payment_status: "unpaid" });
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "needs_attention");
    assert.strictEqual(syncDoc()?.lastErrorCode, "stripe_not_settled");
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("treats an open Stripe session as a retryable failure", async () => {
    seedPending();
    state.session = paidSession({ status: "open", payment_status: "unpaid" });
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "failed");
    assert.strictEqual(syncDoc()?.status, "failed");
    assert.strictEqual(syncDoc()?.lastErrorCode, "stripe_not_settled");
  });

  it("quarantines an amount mismatch between record and canonical session", async () => {
    seedPending();
    state.session = paidSession({ amount_total: 999 });
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "needs_attention");
    assert.strictEqual(syncDoc()?.lastErrorCode, "amount_mismatch");
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("keeps the record retryable when the Stripe fetch itself fails", async () => {
    seedPending();
    state.sessionError = new Error("network down");
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "failed");
    assert.strictEqual(syncDoc()?.status, "failed");
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("keeps the record retryable on QBO 5xx while the payment stays paid", async () => {
    seedPending();
    state.createError = new QboError("QuickBooks is temporarily unavailable.", "unavailable", 502, "tid-err");
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "failed");
    const doc = syncDoc();
    assert.strictEqual(doc?.status, "failed");
    assert.strictEqual(doc?.lastErrorCode, "unavailable");
    assert.strictEqual(doc?.lastQboCorrelationId, "tid-err");
    // The payment record itself is never touched by export failures.
    assert.strictEqual(firestore.docs.get(`payments/${PAYMENT_ID}`)?.status, "paid");
  });

  it("marks QBO 4xx validation failures for attention — retrying cannot help", async () => {
    seedPending();
    state.createError = new QboError("QuickBooks rejected the request.", "validation", 400);
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "needs_attention");
    assert.strictEqual(syncDoc()?.status, "needs_attention");
    assert.strictEqual(syncDoc()?.lastErrorCode, "validation");
  });

  it("refuses to start the QBO create when the claim lease is nearly exhausted", async () => {
    seedPending();
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      // Canonical re-verification consumes all but the last seconds of
      // the 2-minute claim — the create must not begin this late, or a
      // successor could reclaim the record while the POST is in flight.
      state.retrieveDelayMs = 95_000;
      const result = await process(SYNC_ID);
      assert.strictEqual(result.outcome, "failed");
      assert.strictEqual(syncDoc()?.lastErrorCode, "lease_expiring");
      assert.strictEqual(state.createCalls.length, 0);
    } finally {
      state.retrieveDelayMs = 0;
      mock.timers.reset();
    }
  });

  it("records invalid_grant reconnect state as retryable, not lost", async () => {
    seedPending();
    state.tokenError = new QboError(
      "QuickBooks authorization needs to be renewed — reconnect the integration.",
      "authorization_expired"
    );
    const result = await process(SYNC_ID);
    assert.strictEqual(result.outcome, "failed");
    assert.strictEqual(syncDoc()?.lastErrorCode, "authorization_expired");
    assert.strictEqual(state.createCalls.length, 0);
  });
});
