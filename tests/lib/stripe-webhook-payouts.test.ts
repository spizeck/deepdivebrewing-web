import { describe, it, mock } from "node:test";
import assert from "node:assert";

// Webhook-path coverage for payout events: handleStripeWebhook verifies
// the signature at the existing boundary, extracts only the payout id,
// and routes to recordStripePayoutEvent. The heavy ledger build is
// deferred to the route's `after()` — asserted here via the result flags.

mock.module("server-only", { namedExports: {} });

mock.module("firebase-admin/firestore", {
  namedExports: {
    FieldValue: { serverTimestamp: () => ({}) },
    Timestamp: { fromMillis: (ms: number) => ({ ms }) },
  },
});

let signedEvent: Record<string, unknown> = {};
let constructEventError: Error | null = null;

mock.module("@/lib/stripe", {
  namedExports: {
    getStripeClient: () => ({
      webhooks: {
        constructEvent: () => {
          if (constructEventError) throw constructEventError;
          return signedEvent;
        },
      },
    }),
  },
});

mock.module("@/lib/stripe-config", {
  namedExports: {
    getStripeSecretKey: () => "sk_test_fixture",
    getStripeWebhookSecret: () => "whsec_fixture",
    isStripeTestMode: () => true,
    resolveCheckoutReturnBaseUrl: () => "https://example.test",
    isStripeConfigured: () => true,
    getStripeAccountingMode: () => "observe",
    getStripeAutomationCutover: () => null,
  },
});

const payoutCalls: { eventId: string; eventType: string; payoutId: string }[] =
  [];
const payoutOutcome = {
  status: "applied" as const,
  payoutId: "po_1",
  needsLedgerBuild: true,
};
mock.module("@/lib/stripe-payouts", {
  namedExports: {
    recordStripePayoutEvent: async (input: {
      eventId: string;
      eventType: string;
      payoutId: string;
    }) => {
      payoutCalls.push(input);
      return payoutOutcome;
    },
    processStripePayoutLedger: async () => {},
    runStripePayoutSweep: async () => ({}),
    getStripePayoutAutomationView: async () => ({}),
  },
});

// The payments side is not exercised here — a minimal transaction stub
// lets the ignored/duplicate marker paths complete without Firestore.
mock.module("@/lib/firebase-admin-db", {
  namedExports: {
    getFirebaseAdminDb: () => ({
      collection: () => ({ doc: (id: string) => ({ id }) }),
      runTransaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          get: async () => ({ exists: false, data: () => undefined }),
          set: () => {},
          update: () => {},
          create: () => {},
        }),
    }),
  },
});
mock.module("@/lib/log", {
  namedExports: { logInfo: () => {}, logWarn: () => {}, logError: () => {} },
});
mock.module("@/lib/qbo-config", {
  namedExports: {
    getQboEnvironment: () => "sandbox",
    isQboConfigured: () => false,
  },
});
mock.module("@/lib/qbo-sync", {
  namedExports: {
    buildQboSyncRecordDoc: () => null,
    postPaidPaymentToQbo: async () => {},
    qboPaymentCandidate: () => null,
  },
});

function payoutEvent(type: string) {
  return {
    id: "evt_1",
    type,
    data: { object: { id: "po_1", object: "payout", amount: 500 } },
  };
}

describe("handleStripeWebhook payout branch", () => {
  it("routes payout.paid to the payout recorder with only the id", async () => {
    const { handleStripeWebhook } = await import("@/lib/payments-admin");
    signedEvent = payoutEvent("payout.paid");
    const result = await handleStripeWebhook("{}", "sig");
    assert.equal(result.status, "applied");
    assert.equal(result.payoutId, "po_1");
    assert.equal(result.needsLedgerBuild, true);
    assert.equal(result.paymentId, null);
    assert.deepEqual(payoutCalls.at(-1), {
      eventId: "evt_1",
      eventType: "payout.paid",
      payoutId: "po_1",
    });
  });

  it("routes payout.reconciliation_completed the same way", async () => {
    const { handleStripeWebhook } = await import("@/lib/payments-admin");
    signedEvent = payoutEvent("payout.reconciliation_completed");
    const result = await handleStripeWebhook("{}", "sig");
    assert.equal(result.payoutId, "po_1");
    assert.equal(payoutCalls.at(-1)?.eventType, "payout.reconciliation_completed");
  });

  it("ignores payout events whose signed object lacks a payout id", async () => {
    const { handleStripeWebhook } = await import("@/lib/payments-admin");
    signedEvent = {
      id: "evt_2",
      type: "payout.paid",
      data: { object: { object: "payout" } }, // no id
    };
    const result = await handleStripeWebhook("{}", "sig");
    assert.equal(result.status, "ignored");
  });

  it("still ignores unrelated event types without touching payouts", async () => {
    const { handleStripeWebhook } = await import("@/lib/payments-admin");
    signedEvent = {
      id: "evt_3",
      type: "customer.created",
      data: { object: { id: "cus_1", object: "customer" } },
    };
    payoutCalls.length = 0;
    const result = await handleStripeWebhook("{}", "sig");
    assert.equal(result.status, "ignored");
    assert.equal(payoutCalls.length, 0);
  });

  it("propagates signature failures as throws — the route answers 400", async () => {
    const { handleStripeWebhook } = await import("@/lib/payments-admin");
    const err = new Error("No signatures found matching the expected signature");
    (err as { type?: string }).type = "StripeSignatureVerificationError";
    constructEventError = err;
    try {
      await assert.rejects(() => handleStripeWebhook("{}", "sig"), /signature/i);
    } finally {
      constructEventError = null;
    }
  });
});
