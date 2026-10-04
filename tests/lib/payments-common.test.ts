import { describe, it } from "node:test";
import assert from "node:assert";
import {
  assertCheckoutSessionUrl,
  buildCheckoutSessionSpec,
  canonicalSessionDecision,
  describePaymentEvent,
  enrichmentFromPaymentIntent,
  formatUsdMinor,
  isPaymentCancelable,
  isPaymentPayable,
  normalizePaymentStatus,
  outcomeFromSession,
  parseAmountMinor,
  parsePaymentCreateBody,
  paymentCreateMatchesRecord,
  paymentStatusLabel,
  planStripeEventApply,
  processStripeEvent,
  readStripeEventRefs,
  resolveCanonicalEventOutcome,
  serializePayment,
  suggestedAmountMinor,
  toPaymentProviderError,
  PaymentProviderError,
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

// --- Stripe event references + canonical-session resolution ---

// Canonical session shape — mirrors a re-fetched Checkout Session. The
// webhook handler fetches this from Stripe after signature verification;
// the signed event payload itself only contributes ids.
const canonicalSession = {
  id: "cs_test_123",
  object: "checkout.session",
  client_reference_id: VALID_ID,
  metadata: { paymentId: VALID_ID },
  payment_status: "paid",
  status: "complete",
  payment_intent: "pi_123",
  customer: "cus_123",
  amount_total: 8000,
  currency: "usd",
  expires_at: 1_800_000_000,
};

// Event payload embedded object — deliberately carries *wrong* financial
// fields to prove they are never read: only the session id is extracted.
const payloadObject = {
  id: "cs_test_123",
  object: "checkout.session",
  client_reference_id: VALID_ID,
  metadata: { paymentId: VALID_ID },
  payment_status: "paid",
  status: "complete",
  payment_intent: "pi_123",
  amount_total: 1,
  currency: "jpy",
};

const paidEvent = {
  id: "evt_paid",
  type: "checkout.session.completed",
  data: { object: payloadObject },
};

function resolveEvent(
  event: { id: string; type: string },
  canonical: Record<string, unknown>
) {
  const refs = readStripeEventRefs({ ...event, data: { object: canonical } });
  return resolveCanonicalEventOutcome(refs, canonical);
}

describe("readStripeEventRefs", () => {
  it("extracts only ids — the payload's financial fields are inert", () => {
    const refs = readStripeEventRefs(paidEvent);
    assert.strictEqual(refs.eventId, "evt_paid");
    assert.strictEqual(refs.eventType, "checkout.session.completed");
    assert.strictEqual(refs.sessionId, "cs_test_123");
  });

  it("ignores non-session objects and malformed events", () => {
    const foreign = readStripeEventRefs({
      id: "evt_x",
      type: "customer.created",
      data: { object: { id: "cus_9", object: "customer" } },
    });
    assert.strictEqual(foreign.sessionId, null);

    const empty = readStripeEventRefs({ id: "evt_y", type: "x", data: {} });
    assert.strictEqual(empty.sessionId, null);
  });
});

describe("canonicalSessionDecision", () => {
  it("pays on canonical complete+paid regardless of event type", () => {
    for (const type of [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
    ]) {
      assert.deepStrictEqual(
        canonicalSessionDecision(type, canonicalSession),
        { kind: "transition", transition: "paid" },
        `${type} must follow canonical paid state`
      );
    }
  });

  it("maps complete+unpaid via the event type's disambiguation", () => {
    const unpaid = { ...canonicalSession, payment_status: "unpaid" };
    assert.deepStrictEqual(
      canonicalSessionDecision("checkout.session.completed", unpaid),
      { kind: "transition", transition: "processing" }
    );
    assert.deepStrictEqual(
      canonicalSessionDecision("checkout.session.async_payment_failed", unpaid),
      { kind: "transition", transition: "failed" }
    );
    // Manual refresh has no event — unpaid means still processing.
    assert.deepStrictEqual(canonicalSessionDecision(null, unpaid), {
      kind: "transition",
      transition: "processing",
    });
  });

  it("defers when the success event races canonical state", () => {
    const unpaid = { ...canonicalSession, payment_status: "unpaid" };
    assert.deepStrictEqual(
      canonicalSessionDecision(
        "checkout.session.async_payment_succeeded",
        unpaid
      ),
      { kind: "retry" }
    );
  });

  it("maps canonical expiry and defers still-open sessions", () => {
    assert.deepStrictEqual(
      canonicalSessionDecision("checkout.session.expired", {
        ...canonicalSession,
        status: "expired",
      }),
      { kind: "transition", transition: "expired" }
    );
    // Canonical wins even over an expiry event's claim.
    assert.deepStrictEqual(
      canonicalSessionDecision("checkout.session.expired", canonicalSession),
      { kind: "transition", transition: "paid" }
    );
    const open = { ...canonicalSession, status: "open" };
    assert.strictEqual(
      canonicalSessionDecision("checkout.session.completed", open).kind,
      "retry"
    );
    assert.deepStrictEqual(canonicalSessionDecision(null, open), {
      kind: "ignored",
      reason: "session_open",
    });
  });
});

describe("resolveCanonicalEventOutcome", () => {
  it("builds the outcome from the canonical session, not the payload", () => {
    const result = resolveEvent(paidEvent, canonicalSession);
    assert.strictEqual(result.kind, "resolved");
    if (result.kind !== "resolved") return;
    assert.strictEqual(result.resolved.paymentId, VALID_ID);
    assert.strictEqual(result.resolved.outcome?.transition, "paid");
    assert.strictEqual(result.resolved.outcome?.paymentIntentId, "pi_123");
    assert.strictEqual(result.resolved.outcome?.stripeCustomerId, "cus_123");
    assert.strictEqual(result.resolved.outcome?.amountMinor, 8000);
    assert.strictEqual(result.resolved.outcome?.currency, "usd");
    assert.strictEqual(
      result.resolved.outcome?.sessionExpiresAtMillis,
      1_800_000_000 * 1000
    );
  });

  it("a payload claiming paid settles nothing when canonical is unpaid", () => {
    const result = resolveEvent(paidEvent, {
      ...canonicalSession,
      payment_status: "unpaid",
    });
    assert.strictEqual(result.kind, "resolved");
    if (result.kind !== "resolved") return;
    assert.strictEqual(result.resolved.outcome?.transition, "processing");
  });

  it("defers instead of settling when canonical has not caught up", () => {
    const result = resolveEvent(
      { id: "evt_async", type: "checkout.session.async_payment_succeeded" },
      { ...canonicalSession, payment_status: "unpaid" }
    );
    assert.strictEqual(result.kind, "retry");
  });

  it("ignores sessions with no payment reference", () => {
    const result = resolveEvent(paidEvent, {
      ...canonicalSession,
      client_reference_id: null,
      metadata: {},
    });
    assert.strictEqual(result.kind, "resolved");
    if (result.kind !== "resolved") return;
    assert.strictEqual(result.resolved.ignoredReason, "no_payment_reference");
    assert.strictEqual(result.resolved.paymentId, null);
  });
});

// --- Transition planning ---

describe("planStripeEventApply", () => {
  // Records/outcomes carry the matching snapshot fields a canonical
  // session always provides — settlement without them is not testable.
  const record = (status: string) => ({
    status,
    stripeCheckoutSessionId: "cs_test_123",
    amountMinor: 8000,
    currency: "usd",
    eventCount: 2,
  });
  const outcome = (transition: "paid" | "processing" | "failed" | "expired") => ({
    transition,
    sessionId: "cs_test_123",
    paymentIntentId: "pi_123",
    amountMinor: 8000,
    currency: "usd",
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

  it("quarantines a paid claim when canonical amount/currency/session disagree", () => {
    for (const [name, mutated] of [
      ["amount", { ...outcome("paid"), amountMinor: 8001 }],
      ["currency", { ...outcome("paid"), currency: "eur" }],
      ["session", { ...outcome("paid"), sessionId: "cs_test_other" }],
      // Stripe not reporting money facts at all must also fail closed.
      ["missing amount", { ...outcome("paid"), amountMinor: undefined }],
      ["missing currency", { ...outcome("paid"), currency: undefined }],
    ] as const) {
      const plan = planStripeEventApply(record("awaiting_payment"), mutated, "webhook", NOW);
      assert.strictEqual(plan.apply, true, `${name}: quarantine still writes`);
      assert.strictEqual(plan.quarantined !== undefined, true, `${name} quarantined`);
      assert.strictEqual(plan.updates.status, undefined, `${name}: never paid`);
      assert.strictEqual(
        plan.updates.reconciliationIssue,
        plan.quarantined,
        `${name}: record flagged`
      );
      assert.strictEqual(plan.events[0]?.type, "reconciliation_mismatch");
    }
  });

  it("does not duplicate the quarantine audit event on repeat deliveries", () => {
    const flagged = { ...record("awaiting_payment"), reconciliationIssue: "amount_mismatch" };
    const plan = planStripeEventApply(
      flagged,
      { ...outcome("paid"), amountMinor: 8001 },
      "webhook",
      NOW
    );
    assert.strictEqual(plan.apply, false);
    assert.strictEqual(plan.quarantined, "amount_mismatch");
    assert.strictEqual(plan.events.length, 0);
  });

  it("a clean settlement clears a stale reconciliation flag", () => {
    const flagged = { ...record("awaiting_payment"), reconciliationIssue: "amount_mismatch" };
    const plan = planStripeEventApply(flagged, outcome("paid"), "webhook", NOW);
    assert.strictEqual(plan.apply, true);
    assert.strictEqual(plan.updates.status, "paid");
    assert.strictEqual(plan.updates.reconciliationIssue, null);
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
  // Records carry the same snapshot the canonical session reports — a
  // paid transition only applies when they agree.
  const awaitingRecord = {
    status: "awaiting_payment",
    stripeCheckoutSessionId: "cs_test_123",
    amountMinor: 8000,
    currency: "usd",
    eventCount: 2,
  };

  function resolvedFrom(
    event: { id: string; type: string },
    canonical: Record<string, unknown> = canonicalSession
  ) {
    const result = resolveEvent(event, canonical);
    assert.strictEqual(result.kind, "resolved");
    if (result.kind !== "resolved") throw new Error("unreachable");
    return result.resolved;
  }

  it("applies a canonical-paid event once and dedupes the replay", async () => {
    const { store, payments, markers } = fakeStore({
      [VALID_ID]: { ...awaitingRecord },
    });
    const resolved = resolvedFrom(paidEvent);

    const first = await processStripeEvent(resolved, store);
    assert.strictEqual(first.status, "applied");
    assert.strictEqual(payments.get(VALID_ID)?.status, "paid");

    const second = await processStripeEvent(resolved, store);
    assert.strictEqual(second.status, "duplicate");
    assert.strictEqual(markers.get("evt_paid"), "applied");
  });

  it("a second successful event for the same payment does not settle twice", async () => {
    const { store, payments } = fakeStore({
      [VALID_ID]: { ...awaitingRecord, status: "paid", eventCount: 3 },
    });
    const resolved = resolvedFrom({
      id: "evt_async",
      type: "checkout.session.async_payment_succeeded",
    });
    const result = await processStripeEvent(resolved, store);
    assert.strictEqual(result.status, "ignored");
    assert.strictEqual(payments.get(VALID_ID)?.status, "paid");
  });

  it("quarantines — never pays — when canonical amounts disagree", async () => {
    const { store, payments, markers } = fakeStore({
      [VALID_ID]: { ...awaitingRecord },
    });
    const resolved = resolvedFrom(paidEvent, {
      ...canonicalSession,
      amount_total: 9000,
    });
    const result = await processStripeEvent(resolved, store);
    assert.strictEqual(result.status, "quarantined");
    assert.strictEqual(result.quarantined, "amount_mismatch");
    assert.strictEqual(payments.get(VALID_ID)?.status, "awaiting_payment");
    assert.strictEqual(
      payments.get(VALID_ID)?.reconciliationIssue,
      "amount_mismatch"
    );
    assert.strictEqual(markers.get("evt_paid"), "mismatch");
  });

  it("acknowledges events for unknown payments without touching records", async () => {
    const { store, markers, writes } = fakeStore();
    const resolved = resolvedFrom(paidEvent);
    const result = await processStripeEvent(resolved, store);
    assert.strictEqual(result.status, "unknown_payment");
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(markers.get("evt_paid"), "unknown_payment");
  });

  it("acknowledges ignored event types without payment writes", async () => {
    const { store, writes } = fakeStore({
      [VALID_ID]: { ...awaitingRecord },
    });
    // Unhandled event types produce a resolved outcome with no transition.
    const resolved = resolvedFrom(
      { id: "evt_other", type: "customer.created" },
      { object: "customer", id: "cus_9" }
    );
    const result = await processStripeEvent(resolved, store);
    assert.strictEqual(result.status, "ignored");
    assert.strictEqual(writes.length, 0);
  });

  it("does not regress a paid record when a late expired event arrives", async () => {
    const { store, payments } = fakeStore({
      [VALID_ID]: { ...awaitingRecord, status: "paid", eventCount: 3 },
    });
    // Canonical session says expired — the transition is still refused.
    const resolved = resolvedFrom(
      { id: "evt_expired", type: "checkout.session.expired" },
      { ...canonicalSession, status: "expired" }
    );
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
    const flagged = describePaymentEvent({
      type: "reconciliation_mismatch",
      details: { reason: "amount_mismatch" },
    });
    assert.ok(flagged.includes("flagged"));
    assert.ok(flagged.includes("amount_mismatch"));
  });
});

describe("outcomeFromSession", () => {
  it("falls back to client_reference_id when metadata is absent", () => {
    const { paymentId } = outcomeFromSession(
      { ...canonicalSession, metadata: null },
      "paid"
    );
    assert.strictEqual(paymentId, VALID_ID);
  });
});

// --- Checkout URL allowlist ---

describe("assertCheckoutSessionUrl", () => {
  it("accepts Stripe-hosted checkout URLs", () => {
    const url = "https://checkout.stripe.com/c/pay/cs_test_abc#key";
    assert.strictEqual(assertCheckoutSessionUrl(url), url);
    // Live-mode hosted pages share the same origin.
    assert.strictEqual(
      assertCheckoutSessionUrl(
        "https://checkout.stripe.com/c/pay/cs_live_xyz"
      ),
      "https://checkout.stripe.com/c/pay/cs_live_xyz"
    );
  });

  it("rejects insecure, non-Stripe, and malformed URLs", () => {
    for (const bad of [
      "http://checkout.stripe.com/c/pay/cs_test_x",
      "https://checkout.stripe.com.evil.example/pay",
      "https://stripe.com.evil.example/checkout",
      "https://pay.example.com/checkout",
      "javascript:alert(1)",
      "not a url",
      "",
      null,
      undefined,
      42,
    ]) {
      assert.throws(
        () => assertCheckoutSessionUrl(bad),
        (error) => error instanceof PaymentProviderError,
        `expected ${String(bad)} rejected`
      );
    }
  });
});

// --- Idempotent-replay payload matching ---

describe("paymentCreateMatchesRecord", () => {
  const input = {
    clientRequestId: VALID_ID,
    purpose: "brewery_tour_tasting",
    description: "Brewery Tour + Tasting",
    amountMinor: 8000,
    customerName: "Jane Diver",
    customerEmail: "jane@example.com",
    tourDate: "2026-10-15",
    attendeeCount: 4,
    internalNote: "Cruise group",
  };
  const record = {
    purpose: "brewery_tour_tasting",
    description: "Brewery Tour + Tasting",
    amountMinor: 8000,
    customerName: "Jane Diver",
    customerEmail: "jane@example.com",
    tourDate: "2026-10-15",
    attendeeCount: 4,
    internalNote: "Cruise group",
    status: "awaiting_payment",
  };

  it("an identical retry matches", () => {
    assert.strictEqual(paymentCreateMatchesRecord(record, input), true);
  });

  it("any payment-relevant drift conflicts", () => {
    const drifts: [string, Record<string, unknown>][] = [
      ["amount", { ...record, amountMinor: 8001 }],
      ["purpose", { ...record, purpose: "other" }],
      ["description", { ...record, description: "Other" }],
      ["customer name", { ...record, customerName: "Joan" }],
      ["receipt email", { ...record, customerEmail: "joan@example.com" }],
      ["missing email", { ...record, customerEmail: undefined }],
      ["tour date", { ...record, tourDate: "2026-10-16" }],
      ["attendees", { ...record, attendeeCount: 5 }],
      ["note", { ...record, internalNote: "Walk-in" }],
    ];
    for (const [name, stored] of drifts) {
      assert.strictEqual(
        paymentCreateMatchesRecord(stored, input),
        false,
        `${name} drift must conflict`
      );
    }
  });
});

// --- Provider error normalization ---

describe("toPaymentProviderError", () => {
  it("keeps only the provider's machine code — never the raw message", () => {
    const raw = new Error(
      "Stripe raw detail: card 4242 declined; request req_123"
    );
    (raw as Error & { code?: string }).code = "card_declined";
    const normalized = toPaymentProviderError(raw);
    assert.ok(normalized instanceof PaymentProviderError);
    assert.strictEqual(normalized.code, "card_declined");
    assert.strictEqual(normalized.status, 502);
    assert.ok(!normalized.message.includes("4242"));
    assert.ok(!normalized.message.includes("req_123"));
  });

  it("handles non-Stripe failures and passes through already-normalized errors", () => {
    assert.strictEqual(toPaymentProviderError("boom").code, "unexpected_provider_error");
    assert.strictEqual(toPaymentProviderError(null).code, "unexpected_provider_error");
    const already = new PaymentProviderError("rate_limit");
    assert.strictEqual(toPaymentProviderError(already), already);
  });
});
