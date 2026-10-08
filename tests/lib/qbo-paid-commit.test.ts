import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { QboError } from "@/lib/qbo-errors";
import {
  installQboDbMock,
  qboTokensMockExtras,
  withEnv,
} from "./qbo-test-helpers";

// Exercises the durable in-commit enqueue (#179): the QBO sync record is
// created inside the same Firestore transaction that settles the payment,
// driven here through the real webhook handler + real qbo-sync module —
// only the provider boundaries are mocked.

const firestore = installQboDbMock();

const state = {
  event: null as Record<string, unknown> | null,
  session: null as Record<string, unknown> | null,
  intent: null as Record<string, unknown> | null,
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
  foundReceipt: null as { id: string; correlationId?: string } | null,
  createResult: { id: "9001", correlationId: "tid-1" } as {
    id: string;
    correlationId?: string;
  },
  createError: null as unknown,
  createCalls: [] as Record<string, unknown>[],
};

mock.module("@/lib/stripe", {
  namedExports: {
    getStripeClient: () => ({
      webhooks: { constructEvent: () => state.event },
      checkout: {
        sessions: { retrieve: async () => state.session },
      },
      paymentIntents: { retrieve: async () => state.intent },
    }),
  },
});

mock.module("@/lib/stripe-config", {
  namedExports: {
    getStripeWebhookSecret: () => "whsec_test",
    resolveCheckoutReturnBaseUrl: () => "https://deepdivebrewing.com",
  },
});

mock.module("@/lib/qbo-tokens", {
  namedExports: {
    getQuickBooksAccessToken: async () => ({
      accessToken: "at",
      realmId: "realm-prod",
    }),
    ...qboTokensMockExtras(firestore),
  },
});

mock.module("@/lib/qbo-mapping", {
  namedExports: { getQboMappingView: async () => state.mapping },
});

mock.module("@/lib/qbo-api", {
  namedExports: {
    findQboSalesReceiptForMarker: async () => state.foundReceipt,
    createQboSalesReceipt: async (input: {
      payload: Record<string, unknown>;
    }) => {
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

function awaitingPayment() {
  return {
    status: "awaiting_payment",
    stripeCheckoutSessionId: "cs_test_1",
    amountMinor: 500,
    currency: "usd",
    purpose: "other",
    description: "QBO Test",
    customerName: "Chad Nuttall",
    eventCount: 0,
  };
}

function reset() {
  firestore.reset({
    "qboConnections/sandbox": {
      status: "connected",
      realmId: "realm-prod",
      companyCountry: "CW",
      refreshTokenEnc: "enc-rt",
    },
    [`payments/${PAYMENT_ID}`]: awaitingPayment(),
  });
  state.event = {
    id: "evt_paid_1",
    type: "checkout.session.completed",
    data: { object: { object: "checkout.session", id: "cs_test_1" } },
  };
  state.session = {
    id: "cs_test_1",
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    amount_total: 500,
    currency: "usd",
    payment_intent: "pi_1",
    metadata: { paymentId: PAYMENT_ID },
    client_reference_id: PAYMENT_ID,
  };
  state.intent = {
    latest_charge: {
      id: "ch_1",
      receipt_url: "https://pay.stripe.com/receipts/test",
      payment_method_details: { card: { brand: "visa", last4: "4242" } },
    },
  };
  state.foundReceipt = null;
  state.createResult = { id: "9001", correlationId: "tid-1" };
  state.createError = null;
  state.createCalls = [];
  firestore.failGet.clear();
}

async function deliver(env: Record<string, string | undefined> = ENV) {
  const { handleStripeWebhook } = await import("@/lib/payments-admin");
  return withEnv(env, () => handleStripeWebhook("{}", "sig"));
}

function syncDoc() {
  return firestore.docs.get(`${RECORDS}/${SYNC_ID}`);
}

describe("paid commit — durable QBO sync record (#179)", () => {
  it("creates the sync record inside the paid commit and posts the receipt", async () => {
    reset();
    const result = await deliver();
    assert.strictEqual(result.status, "applied");

    // The record was committed atomically with the settlement — the
    // post-commit worker then ran it to completion.
    const doc = syncDoc();
    assert.ok(doc, "sync record must exist even before post-commit work");
    assert.strictEqual(doc.status, "synced");
    assert.strictEqual(doc.syncId, SYNC_ID);
    assert.strictEqual(doc.environment, "sandbox");
    assert.strictEqual(doc.qboEntityId, "9001");

    assert.strictEqual(
      firestore.docs.get(`payments/${PAYMENT_ID}`)?.status,
      "paid"
    );
    assert.strictEqual(state.createCalls.length, 1);
  });

  it("leaves a durable pending record when the post-commit path fails", async () => {
    reset();
    // Simulate the process losing its post-commit work: the enqueue's
    // payment re-read fails, so nothing after the commit runs.
    firestore.failGet.add(`payments/${PAYMENT_ID}`);
    const result = await deliver();
    assert.strictEqual(result.status, "applied");

    // The record landed inside the commit transaction — a later sweep or
    // retry can process it; the payment is not stranded without one.
    const doc = syncDoc();
    assert.ok(doc, "sync record must survive post-commit failure");
    assert.strictEqual(doc.status, "pending");
    assert.strictEqual(doc.attempts, 0);
    assert.strictEqual(
      firestore.docs.get(`payments/${PAYMENT_ID}`)?.status,
      "paid"
    );
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("still settles the payment when QBO is not configured", async () => {
    reset();
    const result = await deliver({ QBO_ENVIRONMENT: undefined });
    assert.strictEqual(result.status, "applied");
    assert.strictEqual(
      firestore.docs.get(`payments/${PAYMENT_ID}`)?.status,
      "paid"
    );
    assert.strictEqual(
      firestore.docs.has(`${RECORDS}/${SYNC_ID}`),
      false,
      "no record is created for an unconfigured deployment"
    );
    assert.strictEqual(state.createCalls.length, 0);
  });

  it("a replayed delivery creates neither a second record nor receipt", async () => {
    reset();
    assert.strictEqual((await deliver()).status, "applied");
    assert.strictEqual((await deliver()).status, "duplicate");

    assert.strictEqual(state.createCalls.length, 1);
    assert.strictEqual(syncDoc()?.status, "synced");
    // Exactly one sync record exists for the payment.
    const recordDocs = [...firestore.docs.keys()].filter((key) =>
      key.startsWith(RECORDS)
    );
    assert.strictEqual(recordDocs.length, 1);
  });

  it("records a provider failure on the record — the payment stays paid", async () => {
    reset();
    state.createError = new QboError(
      "QuickBooks is temporarily unavailable.",
      "unavailable",
      502,
      "tid-err"
    );
    const result = await deliver();
    assert.strictEqual(result.status, "applied");

    const doc = syncDoc();
    assert.strictEqual(doc?.status, "failed");
    assert.strictEqual(doc?.lastErrorCode, "unavailable");
    assert.strictEqual(
      firestore.docs.get(`payments/${PAYMENT_ID}`)?.status,
      "paid"
    );
  });
});
