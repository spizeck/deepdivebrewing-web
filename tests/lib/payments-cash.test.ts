import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { PaymentError } from "@/lib/payments-common";
import {
  installQboDbMock,
  qboTokensMockExtras,
  withEnv,
} from "./qbo-test-helpers";

// Exercises the cash payment rail (issue #206) end to end at the server
// boundary: createAdminPayment/refundAdminPayment run against the real
// qbo-sync module and in-memory Firestore — only the provider boundaries
// (Stripe, QBO HTTP, token storage, mapping read) are mocked, and every
// Stripe call is counted to prove the cash path never touches it.

const firestore = installQboDbMock();

const state = {
  session: null as Record<string, unknown> | null,
  mapping: {
    configured: true,
    mapping: {
      stripeClearingAccountId: "acct-stripe-balance",
      cashDepositAccountId: "acct-cash",
      cardPaymentMethodId: "pm-card",
      cashPaymentMethodId: "pm-cash",
      tourIncomeItemId: "item-tour",
      tastingIncomeItemId: "item-tasting",
      otherIncomeItemId: "item-other",
      fallbackCustomerId: "cust-generic",
    },
  } as { configured: boolean; mapping?: Record<string, string | undefined> },
  stripe: {
    sessionCreate: 0,
    sessionRetrieve: 0,
    sessionExpire: 0,
    intentRetrieve: 0,
    refundCreate: 0,
    refundRetrieve: 0,
  },
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
      webhooks: { constructEvent: () => null },
      checkout: {
        sessions: {
          create: async () => {
            state.stripe.sessionCreate += 1;
            return {
              id: "cs_test_1",
              url: "https://checkout.stripe.com/c/pay/cs_test_1",
              payment_intent: "pi_1",
              customer: "cus_1",
              livemode: false,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            };
          },
          retrieve: async () => {
            state.stripe.sessionRetrieve += 1;
            return state.session;
          },
          expire: async () => {
            state.stripe.sessionExpire += 1;
            return {};
          },
        },
      },
      paymentIntents: {
        retrieve: async () => {
          state.stripe.intentRetrieve += 1;
          return {};
        },
      },
      refunds: {
        create: async () => {
          state.stripe.refundCreate += 1;
          return {};
        },
        retrieve: async () => {
          state.stripe.refundRetrieve += 1;
          return {};
        },
      },
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
const CASH_SYNC_ID = `sandbox:cash_payment:${PAYMENT_ID}`;
const STRIPE_SYNC_ID = `sandbox:stripe_payment:${PAYMENT_ID}`;
const ACTOR = { uid: "admin-1", name: "Sam Admin" };

function cashInput(over: Record<string, unknown> = {}) {
  return {
    clientRequestId: PAYMENT_ID,
    paymentMethod: "cash" as const,
    purpose: "other",
    description: "Walk-in merch",
    amountMinor: 2500,
    customerName: "Walk-in Customer",
    internalNote: "counter sale",
    ...over,
  };
}

function stripeCalls() {
  return (
    state.stripe.sessionCreate +
    state.stripe.sessionRetrieve +
    state.stripe.sessionExpire +
    state.stripe.intentRetrieve +
    state.stripe.refundCreate +
    state.stripe.refundRetrieve
  );
}

function paymentDoc() {
  return firestore.docs.get(`payments/${PAYMENT_ID}`);
}

function paymentEvents() {
  return [...firestore.docs.entries()]
    .filter(([path]) => path.startsWith(`payments/${PAYMENT_ID}/events/`))
    .map(([, doc]) => doc);
}

function reset() {
  firestore.reset({
    "qboConnections/sandbox": {
      status: "connected",
      realmId: "realm-prod",
      companyCountry: "CW",
      refreshTokenEnc: "enc-rt",
    },
  });
  state.session = {
    id: "cs_test_1",
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    amount_total: 2500,
    currency: "usd",
    payment_intent: "pi_1",
    metadata: { paymentId: PAYMENT_ID },
    client_reference_id: PAYMENT_ID,
  };
  state.mapping = {
    configured: true,
    mapping: {
      stripeClearingAccountId: "acct-stripe-balance",
      cashDepositAccountId: "acct-cash",
      cardPaymentMethodId: "pm-card",
      cashPaymentMethodId: "pm-cash",
      tourIncomeItemId: "item-tour",
      tastingIncomeItemId: "item-tasting",
      otherIncomeItemId: "item-other",
      fallbackCustomerId: "cust-generic",
    },
  };
  state.stripe = {
    sessionCreate: 0,
    sessionRetrieve: 0,
    sessionExpire: 0,
    intentRetrieve: 0,
    refundCreate: 0,
    refundRetrieve: 0,
  };
  state.foundReceipt = null;
  state.createResult = { id: "9001", correlationId: "tid-1" };
  state.createError = null;
  state.createCalls = [];
  firestore.failGet.clear();
}

describe("cash payment creation (issue #206)", () => {
  it("records the payment as paid with audit history and a cash sync record — and never calls Stripe", async () => {
    reset();
    const { createAdminPayment } = await import("@/lib/payments-admin");
    const created = await withEnv(ENV, () =>
      createAdminPayment(cashInput(), ACTOR)
    );
    assert.strictEqual(created.replayed, false);

    const doc = paymentDoc();
    assert.ok(doc);
    assert.strictEqual(doc.status, "paid");
    assert.strictEqual(doc.paymentMethod, "cash");
    assert.strictEqual(doc.amountMinor, 2500);
    assert.strictEqual(doc.internalNote, "counter sale");
    assert.ok(doc.paidAt instanceof Date, "paidAt is a concrete timestamp");
    assert.strictEqual(doc.createdByUid, "admin-1");
    assert.strictEqual(doc.eventCount, 2);
    // No Stripe state is ever written for a cash payment.
    assert.strictEqual(doc.stripeCheckoutSessionId, undefined);
    assert.strictEqual(doc.stripeSessionUrl, undefined);
    assert.strictEqual(doc.stripePaymentIntentId, undefined);
    assert.strictEqual(doc.livemode, undefined);

    const types = paymentEvents()
      .map((e) => e.type)
      .sort();
    assert.deepStrictEqual(types, [
      "cash_payment_recorded",
      "payment_created",
    ]);

    // The durable sync record was committed in the same transaction and
    // the post-commit helper then posted it — to the cash account.
    const sync = firestore.docs.get(`${RECORDS}/${CASH_SYNC_ID}`);
    assert.ok(sync, "cash sync record must exist");
    assert.strictEqual(sync.sourceType, "cash_payment");
    assert.strictEqual(sync.status, "synced");
    assert.strictEqual(state.createCalls.length, 1);
    assert.deepStrictEqual(
      state.createCalls[0].DepositToAccountRef,
      { value: "acct-cash" },
      "cash receipts deposit to the cash account, never Stripe clearing"
    );
    assert.deepStrictEqual(
      state.createCalls[0].PaymentMethodRef,
      { value: "pm-cash" },
      "cash receipts name the mapped Cash payment method"
    );
    assert.match(String(state.createCalls[0].PrivateNote), /Cash payment/);

    assert.strictEqual(stripeCalls(), 0, "the cash path must not call Stripe");
  });

  it("an identical retry replays without double-recording; drifted details conflict", async () => {
    reset();
    const { createAdminPayment } = await import("@/lib/payments-admin");
    await withEnv(ENV, () => createAdminPayment(cashInput(), ACTOR));

    const replay = await withEnv(ENV, () =>
      createAdminPayment(cashInput(), ACTOR)
    );
    assert.strictEqual(replay.replayed, true);
    assert.strictEqual(paymentEvents().length, 2);
    assert.strictEqual(state.createCalls.length, 1);

    await assert.rejects(
      withEnv(ENV, () =>
        createAdminPayment(cashInput({ amountMinor: 2600 }), ACTOR)
      ),
      (error: unknown) =>
        error instanceof PaymentError && error.status === 409
    );
    // The conflict wrote nothing — the stored record is authoritative.
    assert.strictEqual(paymentDoc()?.amountMinor, 2500);
  });

  it("the card rail still creates a Stripe Checkout session", async () => {
    reset();
    const { createAdminPayment } = await import("@/lib/payments-admin");
    const created = await withEnv(ENV, () =>
      createAdminPayment(
        cashInput({ paymentMethod: "card", clientRequestId: PAYMENT_ID }),
        ACTOR
      )
    );
    assert.strictEqual(created.replayed, false);
    assert.strictEqual(state.stripe.sessionCreate, 1);

    const doc = paymentDoc();
    assert.strictEqual(doc?.status, "awaiting_payment");
    assert.strictEqual(doc?.paymentMethod, "card");
    assert.strictEqual(doc?.stripeCheckoutSessionId, "cs_test_1");
    // Card payments only get a sync record when they settle — none yet.
    assert.strictEqual(firestore.docs.has(`${RECORDS}/${STRIPE_SYNC_ID}`), false);
    assert.strictEqual(state.createCalls.length, 0);
  });
});

describe("cash refunds (issue #206)", () => {
  function paidCashRecord(over: Record<string, unknown> = {}) {
    return {
      status: "paid",
      paymentMethod: "cash",
      amountMinor: 2500,
      currency: "usd",
      paidAt: new Date(Date.now() - 10 * 60_000),
      eventCount: 2,
      ...over,
    };
  }

  it("commits paid→refunded in one transaction with a cash audit event — no Stripe calls", async () => {
    reset();
    firestore.docs.set(`payments/${PAYMENT_ID}`, paidCashRecord());
    const { refundAdminPayment } = await import("@/lib/payments-admin");
    await refundAdminPayment(PAYMENT_ID, { reason: "entered twice" }, ACTOR);

    const doc = paymentDoc();
    assert.strictEqual(doc?.status, "refunded");
    assert.strictEqual(doc?.refundAmountMinor, 2500);
    assert.strictEqual(doc?.refundCurrency, "usd");
    assert.strictEqual(doc?.refundReason, "entered twice");
    assert.strictEqual(doc?.refundedByUid, "admin-1");
    assert.strictEqual(doc?.stripeRefundId, undefined);
    assert.strictEqual(doc?.eventCount, 3);

    const types = paymentEvents().map((e) => e.type);
    assert.deepStrictEqual(types, ["cash_refund_recorded"]);
    assert.strictEqual(
      state.stripe.refundCreate + state.stripe.refundRetrieve,
      0,
      "cash refunds must never call Stripe"
    );
    assert.strictEqual(stripeCalls(), 0);
  });

  it("is idempotent — a replay adds no event and writes no facts twice", async () => {
    reset();
    firestore.docs.set(`payments/${PAYMENT_ID}`, paidCashRecord());
    const { refundAdminPayment } = await import("@/lib/payments-admin");
    const input = { reason: "entered twice" };
    await refundAdminPayment(PAYMENT_ID, input, ACTOR);
    await refundAdminPayment(PAYMENT_ID, input, ACTOR);

    assert.strictEqual(paymentEvents().length, 1);
    assert.strictEqual(paymentDoc()?.eventCount, 3);
    assert.strictEqual(stripeCalls(), 0);
  });

  it("rejects outside the refund window without touching the record", async () => {
    reset();
    firestore.docs.set(
      `payments/${PAYMENT_ID}`,
      paidCashRecord({ paidAt: new Date(Date.now() - 2 * 60 * 60_000) })
    );
    const { refundAdminPayment } = await import("@/lib/payments-admin");
    await assert.rejects(
      refundAdminPayment(PAYMENT_ID, { reason: "too late" }, ACTOR),
      (error: unknown) =>
        error instanceof PaymentError && error.status === 409
    );
    assert.strictEqual(paymentDoc()?.status, "paid");
    assert.strictEqual(paymentEvents().length, 0);
    assert.strictEqual(stripeCalls(), 0);
  });
});

describe("cash QuickBooks posting (issue #206)", () => {
  it("fails closed into needs_attention when no cash account is mapped", async () => {
    reset();
    state.mapping.mapping = {
      ...state.mapping.mapping!,
      cashDepositAccountId: undefined,
    };
    const { createAdminPayment } = await import("@/lib/payments-admin");
    await withEnv(ENV, () => createAdminPayment(cashInput(), ACTOR));

    const sync = firestore.docs.get(`${RECORDS}/${CASH_SYNC_ID}`);
    assert.strictEqual(sync?.status, "needs_attention");
    assert.strictEqual(sync?.lastErrorCode, "missing_cashDepositAccountId");
    assert.strictEqual(state.createCalls.length, 0);
    // The payment stays paid — the accounting export never rolls it back.
    assert.strictEqual(paymentDoc()?.status, "paid");
  });

  it("fails closed into needs_attention when no cash payment method is mapped", async () => {
    reset();
    state.mapping.mapping = {
      ...state.mapping.mapping!,
      cashPaymentMethodId: undefined,
    };
    const { createAdminPayment } = await import("@/lib/payments-admin");
    await withEnv(ENV, () => createAdminPayment(cashInput(), ACTOR));

    const sync = firestore.docs.get(`${RECORDS}/${CASH_SYNC_ID}`);
    assert.strictEqual(sync?.status, "needs_attention");
    assert.strictEqual(sync?.lastErrorCode, "missing_cashPaymentMethodId");
    assert.strictEqual(state.createCalls.length, 0);
    assert.strictEqual(paymentDoc()?.status, "paid");
  });

  it("a rail-mismatched sync record fails closed — a cash record can never post a card payment", async () => {
    reset();
    // Paid card payment (legacy shape: no paymentMethod field) + a sync
    // record claiming the cash rail.
    firestore.docs.set(`payments/${PAYMENT_ID}`, {
      status: "paid",
      amountMinor: 2500,
      currency: "usd",
      purpose: "other",
      paidAt: new Date(),
      stripeCheckoutSessionId: "cs_test_1",
    });
    const { buildQboSyncRecordDoc, processQboSyncRecord, qboCashPaymentCandidate } =
      await import("@/lib/qbo-sync");
    const { normalizeQboSyncCandidate } = await import("@/lib/qbo-common");
    const candidate = normalizeQboSyncCandidate(
      qboCashPaymentCandidate(
        { amountMinor: 2500, currency: "usd", paidAt: new Date() },
        PAYMENT_ID
      )
    );
    firestore.docs.set(
      `${RECORDS}/${CASH_SYNC_ID}`,
      buildQboSyncRecordDoc("sandbox", candidate)
    );

    const outcome = await withEnv(ENV, () =>
      processQboSyncRecord(CASH_SYNC_ID)
    );
    assert.strictEqual(outcome.outcome, "needs_attention");
    const sync = firestore.docs.get(`${RECORDS}/${CASH_SYNC_ID}`);
    assert.strictEqual(sync?.lastErrorCode, "method_mismatch");
    assert.strictEqual(state.createCalls.length, 0);
    // The rail check fires before Stripe is ever consulted.
    assert.strictEqual(stripeCalls(), 0);
  });

  it("a legacy card record (no paymentMethod) still posts through Stripe clearing", async () => {
    reset();
    firestore.docs.set(`payments/${PAYMENT_ID}`, {
      status: "paid",
      amountMinor: 2500,
      currency: "usd",
      purpose: "other",
      paidAt: new Date(),
      stripeCheckoutSessionId: "cs_test_1",
      stripePaymentIntentId: "pi_1",
    });
    const { postPaidPaymentToQbo } = await import("@/lib/qbo-sync");
    await withEnv(ENV, () => postPaidPaymentToQbo(PAYMENT_ID));

    const sync = firestore.docs.get(`${RECORDS}/${STRIPE_SYNC_ID}`);
    assert.ok(sync, "legacy card payments still get a stripe sync record");
    assert.strictEqual(sync.status, "synced");
    assert.strictEqual(state.stripe.sessionRetrieve, 1);
    assert.deepStrictEqual(state.createCalls[0].DepositToAccountRef, {
      value: "acct-stripe-balance",
    });
    assert.deepStrictEqual(state.createCalls[0].PaymentMethodRef, {
      value: "pm-card",
    });
  });
});
