import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildCheckoutSessionSpec,
  describePaymentEvent,
  enrichmentFromPaymentIntent,
  formatUsdMinor,
  isPaymentCancelable,
  isPaymentPayable,
  normalizePaymentStatus,
  outcomeFromSession,
  parseAmountMinor,
  parsePaymentCreateBody,
  paymentStatusLabel,
  planStripeEventApply,
  processStripeEvent,
  resolveStripeEventOutcome,
  serializePayment,
  suggestedAmountMinor,
  PAYMENT_MAX_AMOUNT_MINOR,
  type StripeEventStore,
  type StripeEventTx,
} from "@/lib/payments-common";

const VALID_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const baseBody = {
  clientRequestId: VALID_ID,
  purpose: "brewery_tour_tasting",
  description: "Brewery Tour + Tasting",
  amount: "80.00",
  customerName: "Jane Diver",
};

// --- Money ---

describe("parseAmountMinor", () => {
  it("accepts whole-dollar, cents, and $-prefixed strings", () => {
    assert.deepStrictEqual(parseAmountMinor("40"), { ok: true, minor: 4000 });
    assert.deepStrictEqual(parseAmountMinor("40.00"), { ok: true, minor: 4000 });
    assert.deepStrictEqual(parseAmountMinor("12.50"), { ok: true, minor: 1250 });
    assert.deepStrictEqual(parseAmountMinor("$20"), { ok: true, minor: 2000 });
    assert.deepStrictEqual(parseAmountMinor(" 0.05 "), { ok: true, minor: 5 });
  });

  it("accepts cent-exact numbers and rejects fractional cents", () => {
    assert.deepStrictEqual(parseAmountMinor(40), { ok: true, minor: 4000 });
    assert.deepStrictEqual(parseAmountMinor(19.99), { ok: true, minor: 1999 });
    assert.strictEqual(parseAmountMinor(19.999).ok, false);
    assert.strictEqual(parseAmountMinor(0.001).ok, false);
  });

  it("rejects zero, negative, malformed, and implausible amounts", () => {
    for (const bad of ["0", "0.00", "-5", "-5.00", "abc", "", "1.234", "12.34.5", null, undefined, NaN, Infinity]) {
      assert.strictEqual(parseAmountMinor(bad).ok, false, `expected ${String(bad)} rejected`);
    }
    // Exactly at the cap is allowed; one cent over is not.
    assert.deepStrictEqual(parseAmountMinor("10000"), {
      ok: true,
      minor: PAYMENT_MAX_AMOUNT_MINOR,
    });
    assert.strictEqual(parseAmountMinor("10000.01").ok, false);
    assert.strictEqual(parseAmountMinor(10001).ok, false);
  });
});

describe("formatUsdMinor", () => {
  it("formats minor units as USD", () => {
    assert.strictEqual(formatUsdMinor(4000), "$40.00");
    assert.strictEqual(formatUsdMinor(1999), "$19.99");
    assert.strictEqual(formatUsdMinor(undefined), "—");
  });
});

describe("suggestedAmountMinor", () => {
  it("derives tour prices from canonical TOUR_PRODUCTS", () => {
    assert.strictEqual(suggestedAmountMinor("brewery_tour", 2), 4000);
    assert.strictEqual(suggestedAmountMinor("brewery_tour_tasting", 3), 12000);
  });
  it("returns null without a per-person price or attendee count", () => {
    assert.strictEqual(suggestedAmountMinor("private_tour", 4), null);
    assert.strictEqual(suggestedAmountMinor("brewery_tour", undefined), null);
    assert.strictEqual(suggestedAmountMinor("brewery_tour", 0), null);
  });
});

// --- Create-body validation ---

describe("parsePaymentCreateBody", () => {
  it("accepts a minimal valid body", () => {
    const result = parsePaymentCreateBody(baseBody);
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.input.amountMinor, 8000);
      assert.strictEqual(result.input.purpose, "brewery_tour_tasting");
      assert.strictEqual(result.input.customerEmail, undefined);
    }
  });

  it("accepts the full field set", () => {
    // Derived from the current year — a hardcoded year goes stale once it
    // falls outside TOUR_DATE_MAX_YEARS_AWAY.
    const tourDate = `${new Date().getFullYear() + 1}-10-15`;
    const result = parsePaymentCreateBody({
      ...baseBody,
      customerEmail: "jane@example.com",
      tourDate,
      attendeeCount: 4,
      internalNote: "Cruise group",
    });
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.input.tourDate, tourDate);
      assert.strictEqual(result.input.attendeeCount, 4);
    }
  });

  it("rejects a missing or malformed clientRequestId", () => {
    for (const id of [undefined, "", "not-a-uuid", "12345"]) {
      assert.strictEqual(
        parsePaymentCreateBody({ ...baseBody, clientRequestId: id }).ok,
        false,
        `expected id ${String(id)} rejected`
      );
    }
  });

  it("rejects unknown purposes", () => {
    assert.strictEqual(
      parsePaymentCreateBody({ ...baseBody, purpose: "free_beer" }).ok,
      false
    );
  });

  it("rejects missing description, name, and bad amounts", () => {
    assert.strictEqual(
      parsePaymentCreateBody({ ...baseBody, description: "  " }).ok,
      false
    );
    assert.strictEqual(
      parsePaymentCreateBody({ ...baseBody, customerName: "" }).ok,
      false
    );
    assert.strictEqual(
      parsePaymentCreateBody({ ...baseBody, amount: "-10" }).ok,
      false
    );
    assert.strictEqual(
      parsePaymentCreateBody({ ...baseBody, amount: "99999999" }).ok,
      false
    );
  });

  it("rejects malformed email and impossible tour dates", () => {
    assert.strictEqual(
      parsePaymentCreateBody({ ...baseBody, customerEmail: "not-an-email" }).ok,
      false
    );
    assert.strictEqual(
      parsePaymentCreateBody({ ...baseBody, tourDate: "2026-02-30" }).ok,
      false
    );
    assert.strictEqual(
      parsePaymentCreateBody({ ...baseBody, tourDate: "1999-01-01" }).ok,
      false
    );
  });

  it("rejects non-integer or out-of-range attendee counts", () => {
    for (const count of [0, -2, 1.5, 9999, "abc"]) {
      assert.strictEqual(
        parsePaymentCreateBody({ ...baseBody, attendeeCount: count }).ok,
        false,
        `expected count ${String(count)} rejected`
      );
    }
    assert.strictEqual(
      parsePaymentCreateBody({ ...baseBody, attendeeCount: "6" }).ok,
      true
    );
  });
});

// --- Checkout session spec ---

describe("buildCheckoutSessionSpec", () => {
  const spec = buildCheckoutSessionSpec({
    paymentId: VALID_ID,
    purpose: "brewery_tour",
    description: "Brewery Tour",
    amountMinor: 2000,
    customerEmail: "jane@example.com",
    successUrl: "https://deepdivebrewing.com/pay/complete",
    cancelUrl: "https://deepdivebrewing.com/pay/cancelled",
  });

  it("carries the trusted server-side amount and USD currency", () => {
    assert.strictEqual(spec.mode, "payment");
    assert.strictEqual(spec.line_items[0].price_data.unit_amount, 2000);
    assert.strictEqual(spec.line_items[0].price_data.currency, "usd");
    assert.strictEqual(spec.line_items[0].quantity, 1);
  });

  it("correlates by internal payment id without PII in metadata", () => {
    assert.strictEqual(spec.client_reference_id, VALID_ID);
    assert.strictEqual(spec.metadata.paymentId, VALID_ID);
    assert.strictEqual(spec.payment_intent_data.metadata.paymentId, VALID_ID);
    for (const value of Object.values(spec.metadata)) {
      assert.ok(!value.includes("@"), "metadata must not carry PII");
    }
    // Receipt email goes to the dedicated Stripe field, not metadata.
    assert.strictEqual(spec.customer_email, "jane@example.com");
  });

  it("sets receipt_email so Stripe emails the receipt automatically", () => {
    // customer_email only prefills the form — receipt_email is what
    // guarantees Stripe sends the customer a receipt on success.
    assert.strictEqual(
      spec.payment_intent_data.receipt_email,
      "jane@example.com"
    );

    const noEmail = buildCheckoutSessionSpec({
      paymentId: VALID_ID,
      purpose: "other",
      description: "Ad hoc charge",
      amountMinor: 500,
      successUrl: "https://deepdivebrewing.com/pay/complete",
      cancelUrl: "https://deepdivebrewing.com/pay/cancelled",
    });
    assert.strictEqual(noEmail.payment_intent_data.receipt_email, undefined);
    assert.strictEqual(noEmail.customer_email, undefined);
  });
});

// --- Stripe event resolution ---

const sessionObject = {
  id: "cs_test_123",
  object: "checkout.session",
  client_reference_id: VALID_ID,
  metadata: { paymentId: VALID_ID },
  payment_status: "paid",
  status: "complete",
  payment_intent: "pi_123",
  customer: "cus_123",
  expires_at: 1_800_000_000,
};

describe("resolveStripeEventOutcome", () => {
  it("maps a paid checkout.session.completed to a paid outcome", () => {
    const resolved = resolveStripeEventOutcome({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: sessionObject },
    });
    assert.strictEqual(resolved.paymentId, VALID_ID);
    assert.strictEqual(resolved.outcome?.transition, "paid");
    assert.strictEqual(resolved.outcome?.paymentIntentId, "pi_123");
    assert.strictEqual(resolved.outcome?.stripeCustomerId, "cus_123");
    assert.strictEqual(
      resolved.outcome?.sessionExpiresAtMillis,
      1_800_000_000 * 1000
    );
  });

  it("maps an unpaid completion to processing", () => {
    const resolved = resolveStripeEventOutcome({
      id: "evt_2",
      type: "checkout.session.completed",
      data: { object: { ...sessionObject, payment_status: "unpaid" } },
    });
    assert.strictEqual(resolved.outcome?.transition, "processing");
  });

  it("maps async outcomes and expiry", () => {
    const succeeded = resolveStripeEventOutcome({
      id: "evt_3",
      type: "checkout.session.async_payment_succeeded",
      data: { object: sessionObject },
    });
    assert.strictEqual(succeeded.outcome?.transition, "paid");

    const failed = resolveStripeEventOutcome({
      id: "evt_4",
      type: "checkout.session.async_payment_failed",
      data: { object: sessionObject },
    });
    assert.strictEqual(failed.outcome?.transition, "failed");

    const expired = resolveStripeEventOutcome({
      id: "evt_5",
      type: "checkout.session.expired",
      data: { object: sessionObject },
    });
    assert.strictEqual(expired.outcome?.transition, "expired");
  });

  it("ignores unhandled event types and sessions without a payment reference", () => {
    const unhandled = resolveStripeEventOutcome({
      id: "evt_6",
      type: "customer.created",
      data: { object: sessionObject },
    });
    assert.strictEqual(unhandled.ignoredReason, "unhandled_event_type");

    const noRef = resolveStripeEventOutcome({
      id: "evt_7",
      type: "checkout.session.completed",
      data: {
        object: { ...sessionObject, client_reference_id: null, metadata: {} },
      },
    });
    assert.strictEqual(noRef.ignoredReason, "no_payment_reference");
  });
});

// --- Transition planning ---

describe("planStripeEventApply", () => {
  const record = (status: string) => ({
    status,
    stripeCheckoutSessionId: "cs_test_123",
    eventCount: 2,
  });
  const outcome = (transition: "paid" | "processing" | "failed" | "expired") => ({
    transition,
    paymentIntentId: "pi_123",
  });
  const NOW = new Date("2026-10-03T12:00:00.000Z");

  it("advances awaiting_payment → paid with an audit event", () => {
    const plan = planStripeEventApply(record("awaiting_payment"), outcome("paid"), "webhook", NOW);
    assert.strictEqual(plan.apply, true);
    assert.strictEqual(plan.updates.status, "paid");
    assert.strictEqual(plan.updates.paidAt, NOW);
    assert.strictEqual(plan.events[0]?.type, "payment_succeeded");
  });

  it("advances awaiting_payment → processing → paid across out-of-order-safe steps", () => {
    const processing = planStripeEventApply(record("awaiting_payment"), outcome("processing"), "webhook", NOW);
    assert.strictEqual(processing.apply, true);
    assert.strictEqual(processing.updates.status, "processing");

    const paid = planStripeEventApply(record("processing"), outcome("paid"), "webhook", NOW);
    assert.strictEqual(paid.apply, true);
    assert.strictEqual(paid.updates.status, "paid");
  });

  it("marks failure from processing and expiry from awaiting", () => {
    const failed = planStripeEventApply(record("processing"), outcome("failed"), "webhook", NOW);
    assert.strictEqual(failed.updates.status, "failed");
    assert.strictEqual(failed.events[0]?.type, "payment_failed");

    const expired = planStripeEventApply(record("awaiting_payment"), outcome("expired"), "webhook", NOW);
    assert.strictEqual(expired.updates.status, "expired");
    assert.strictEqual(expired.events[0]?.type, "session_expired");
  });

  it("never regresses Stripe-terminal records on late/duplicate events", () => {
    // paid absorbs everything except a (harmless) repeated paid.
    for (const t of ["processing", "failed", "expired"] as const) {
      assert.strictEqual(
        planStripeEventApply(record("paid"), outcome(t), "webhook", NOW).apply,
        false,
        `paid must not regress on ${t}`
      );
    }
    // expired and canceled are likewise terminal for Stripe events.
    assert.strictEqual(
      planStripeEventApply(record("expired"), outcome("failed"), "webhook", NOW).apply,
      false
    );
    // staff-canceled outranks a late session_expired.
    assert.strictEqual(
      planStripeEventApply(record("canceled"), outcome("expired"), "webhook", NOW).apply,
      false
    );
    // but a payment Stripe says was captured wins even over our cancel flag.
    assert.strictEqual(
      planStripeEventApply(record("canceled"), outcome("paid"), "webhook", NOW).apply,
      true
    );
  });

  it("never sends a failed record back to processing", () => {
    // A Checkout Session that async-failed is complete+unpaid and cannot
    // be retried — neither a late webhook nor a manual refresh (which maps
    // that session state to "processing") may resurrect it to pending.
    for (const source of ["webhook", "manual_refresh"] as const) {
      assert.strictEqual(
        planStripeEventApply(record("failed"), outcome("processing"), source, NOW).apply,
        false,
        `failed must not regress to processing via ${source}`
      );
    }
  });

  it("is a no-op when the transition does not advance the record", () => {
    assert.strictEqual(
      planStripeEventApply(record("paid"), outcome("paid"), "webhook", NOW).apply,
      false
    );
    assert.strictEqual(
      planStripeEventApply(record("expired"), outcome("processing"), "webhook", NOW).apply,
      false
    );
  });

  it("merges enrichment updates on apply", () => {
    const plan = planStripeEventApply(
      record("awaiting_payment"),
      { ...outcome("paid"), extraUpdates: { receiptUrl: "https://pay.stripe.com/receipts/x" } },
      "webhook",
      NOW
    );
    assert.strictEqual(plan.updates.receiptUrl, "https://pay.stripe.com/receipts/x");
  });
});

// --- Webhook orchestration ---

// In-memory StripeEventStore — same closure shape as the Firestore-backed
// one in lib/payments-admin.ts, no emulator needed.
function fakeStore(seed?: Record<string, Record<string, unknown>>) {
  const payments = new Map<string, Record<string, unknown>>(
    Object.entries(seed ?? {})
  );
  const markers = new Map<string, string>();
  const writes: { id: string; updates: Record<string, unknown> }[] = [];
  const store: StripeEventStore = {
    transact: async <R>(work: (tx: StripeEventTx) => Promise<R>) =>
      work({
        stripeEventProcessed: async (id) => markers.has(id),
        getPayment: async (id) => payments.get(id) ?? null,
        updatePayment: async (id, updates, events) => {
          writes.push({ id, updates });
          payments.set(id, { ...payments.get(id), ...updates });
          void events;
        },
        markStripeEventProcessed: async (id, result) => {
          markers.set(id, result);
        },
      }),
  };
  return { store, payments, markers, writes };
}

describe("processStripeEvent", () => {
  const paidEvent = {
    id: "evt_paid",
    type: "checkout.session.completed",
    data: { object: sessionObject },
  };

  it("applies a valid event once and dedupes the replay", async () => {
    const { store, payments, markers } = fakeStore({
      [VALID_ID]: { status: "awaiting_payment", eventCount: 2 },
    });
    const resolved = resolveStripeEventOutcome(paidEvent);

    const first = await processStripeEvent(resolved, store);
    assert.strictEqual(first.status, "applied");
    assert.strictEqual(payments.get(VALID_ID)?.status, "paid");

    const second = await processStripeEvent(resolved, store);
    assert.strictEqual(second.status, "duplicate");
    assert.strictEqual(markers.get("evt_paid"), "applied");
  });

  it("acknowledges events for unknown payments without touching records", async () => {
    const { store, markers, writes } = fakeStore();
    const resolved = resolveStripeEventOutcome(paidEvent);
    const result = await processStripeEvent(resolved, store);
    assert.strictEqual(result.status, "unknown_payment");
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(markers.get("evt_paid"), "unknown_payment");
  });

  it("acknowledges ignored event types without payment writes", async () => {
    const { store, writes } = fakeStore({
      [VALID_ID]: { status: "awaiting_payment" },
    });
    const resolved = resolveStripeEventOutcome({
      id: "evt_other",
      type: "customer.created",
      data: { object: sessionObject },
    });
    const result = await processStripeEvent(resolved, store);
    assert.strictEqual(result.status, "ignored");
    assert.strictEqual(writes.length, 0);
  });

  it("does not regress a paid record when a late expired event arrives", async () => {
    const { store, payments } = fakeStore({
      [VALID_ID]: { status: "paid", eventCount: 3 },
    });
    const resolved = resolveStripeEventOutcome({
      id: "evt_expired",
      type: "checkout.session.expired",
      data: { object: sessionObject },
    });
    const result = await processStripeEvent(resolved, store);
    assert.strictEqual(result.status, "ignored");
    assert.strictEqual(payments.get(VALID_ID)?.status, "paid");
  });
});

// --- Serialization + misc ---

describe("serializePayment", () => {
  it("produces ISO-timestamped, defaulted views", () => {
    const view = serializePayment(VALID_ID, {
      purpose: "brewery_tour",
      description: "Brewery Tour",
      amountMinor: 4000,
      currency: "usd",
      customerName: "Jane",
      status: "awaiting_payment",
      livemode: false,
      createdAt: { toDate: () => new Date("2026-10-03T10:00:00.000Z") },
      paidAt: 1_800_000_000_000,
    });
    assert.strictEqual(view.status, "awaiting_payment");
    assert.strictEqual(view.livemode, false);
    assert.strictEqual(view.createdAt, "2026-10-03T10:00:00.000Z");
    assert.strictEqual(view.paidAt, new Date(1_800_000_000_000).toISOString());
    assert.strictEqual(view.receiptUrl, undefined);
  });

  it("normalizes missing/unknown statuses", () => {
    assert.strictEqual(normalizePaymentStatus(undefined), "created");
    assert.strictEqual(normalizePaymentStatus("garbage"), "created");
    assert.strictEqual(paymentStatusLabel("awaiting_payment"), "Awaiting payment");
  });
});

describe("enrichmentFromPaymentIntent", () => {
  it("extracts only safe display metadata", () => {
    const updates = enrichmentFromPaymentIntent({
      id: "pi_123",
      latest_charge: {
        id: "ch_123",
        receipt_url: "https://pay.stripe.com/receipts/x",
        payment_method_details: {
          card: { brand: "visa", last4: "4242" },
        },
      },
    });
    assert.strictEqual(updates.stripeChargeId, "ch_123");
    assert.strictEqual(updates.receiptUrl, "https://pay.stripe.com/receipts/x");
    assert.strictEqual(updates.paymentMethodBrand, "visa");
    assert.strictEqual(updates.paymentMethodLast4, "4242");
    // No PAN or raw payload fields are ever emitted.
    assert.strictEqual(Object.keys(updates).length, 4);
  });
});

describe("status helpers", () => {
  it("only awaiting_payment is payable; only created/awaiting are cancelable", () => {
    assert.strictEqual(isPaymentPayable("awaiting_payment"), true);
    assert.strictEqual(isPaymentPayable("paid"), false);
    assert.strictEqual(isPaymentCancelable("created"), true);
    assert.strictEqual(isPaymentCancelable("awaiting_payment"), true);
    assert.strictEqual(isPaymentCancelable("paid"), false);
    assert.strictEqual(isPaymentCancelable("expired"), false);
  });
});

describe("describePaymentEvent", () => {
  it("renders readable lines", () => {
    assert.strictEqual(
      describePaymentEvent({ type: "payment_succeeded" }),
      "Payment succeeded"
    );
    assert.strictEqual(
      describePaymentEvent({
        type: "payment_failed",
        details: { message: "card declined" },
      }),
      "Payment failed — card declined"
    );
    assert.strictEqual(
      describePaymentEvent({ type: "payment_canceled" }),
      "Payment canceled by staff"
    );
  });
});

describe("outcomeFromSession", () => {
  it("falls back to client_reference_id when metadata is absent", () => {
    const { paymentId } = outcomeFromSession(
      { ...sessionObject, metadata: null },
      "paid"
    );
    assert.strictEqual(paymentId, VALID_ID);
  });
});
