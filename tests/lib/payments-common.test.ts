import { describe, it } from "node:test";
import assert from "node:assert";
import {
  assertCheckoutSessionUrl,
  buildCheckoutSessionSpec,
  canonicalSessionDecision,
  decideRefundFromPaymentIntent,
  describePaymentEvent,
  enrichmentFromPaymentIntent,
  formatUsdMinor,
  isCollectedForDailyTotal,
  isPaymentCancelable,
  isPaymentMethod,
  isPaymentPayable,
  normalizePaymentMethod,
  normalizePaymentStatus,
  outcomeFromSession,
  parseAmountMinor,
  parsePaymentCreateBody,
  parseRefundBody,
  paymentCreateMatchesRecord,
  paymentMethodLabel,
  paymentRefundEligibility,
  paymentStatusLabel,
  planCashRefund,
  planRefundClaim,
  planStripeEventApply,
  processStripeEvent,
  readStripeEventRefs,
  refundFactsFromStripeRefund,
  refundIdempotencyKey,
  resolveCanonicalEventOutcome,
  serializePayment,
  suggestedAmountMinor,
  timestampMillis,
  toPaymentProviderError,
  PaymentProviderError,
  PAYMENT_MAX_AMOUNT_MINOR,
  REFUND_CONFIRMATION_PHRASE,
  REFUND_REASON_MAX_LENGTH,
  REFUND_WINDOW_MS,
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

  it("restricts Checkout to the card payment rail — delayed methods are not wired", () => {
    // ["card"] keeps Checkout on the card rail: bank debits, BNPL, and
    // other delayed/async methods are never offered. Accelerated card
    // methods (Link, Apple Pay, Google Pay) ride this rail and may still
    // appear by customer device/account eligibility — that is intended.
    assert.deepStrictEqual(spec.payment_method_types, ["card"]);
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

  it("sets receipt_email so Stripe can email the customer a receipt", () => {
    // customer_email only prefills the form — receipt_email supplies the
    // address Stripe emails receipts to when the account's email settings
    // allow it (and never in test mode; the hosted receipt URL is the
    // staff-visible fallback either way).
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

  it("a webhook that loses the manual-refresh race is ignored once, then deduped on resend", async () => {
    // The record is already `paid` (manual refresh settled it before
    // Stripe's delivery arrived). First processing of this event id is a
    // valid no-op — `ignored`, with a marker so Stripe does not retry.
    const { store, payments, markers, writes } = fakeStore({
      [VALID_ID]: { ...awaitingRecord, status: "paid", eventCount: 3 },
    });
    const resolved = resolvedFrom(paidEvent);

    const first = await processStripeEvent(resolved, store);
    assert.strictEqual(first.status, "ignored");
    assert.strictEqual(markers.get("evt_paid"), "ignored");
    assert.strictEqual(payments.get(VALID_ID)?.status, "paid");
    // No payment write: no second payment_succeeded, no re-enrichment.
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(payments.get(VALID_ID)?.eventCount, 3);

    // A resend of the same Stripe event id exits as `duplicate` — again
    // with no writes and no state regression.
    const second = await processStripeEvent(resolved, store);
    assert.strictEqual(second.status, "duplicate");
    assert.strictEqual(payments.get(VALID_ID)?.status, "paid");
    assert.strictEqual(writes.length, 0);
    assert.strictEqual(payments.get(VALID_ID)?.eventCount, 3);
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
    paymentMethod: "card" as const,
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

  it("a rail mismatch conflicts — the same reference can never flip between card and cash", () => {
    assert.strictEqual(
      paymentCreateMatchesRecord(
        { ...record, paymentMethod: "cash" },
        input
      ),
      false
    );
    // Legacy card records carry no field — they still match a card retry.
    assert.strictEqual(paymentCreateMatchesRecord(record, input), true);
    assert.strictEqual(
      paymentCreateMatchesRecord(record, { ...input, paymentMethod: "cash" }),
      false
    );
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

// --- Refunds ---

const PAID_AT = new Date("2026-10-03T12:00:00.000Z").getTime();

const refundArgs = (over: Partial<Parameters<typeof paymentRefundEligibility>[0]> = {}) => ({
  status: "paid",
  paidAtMillis: PAID_AT,
  hasStripePaymentRef: true,
  nowMillis: PAID_AT + 30 * 60 * 1000, // 30 minutes in
  ...over,
});

describe("paymentRefundEligibility", () => {
  it("accepts a paid payment inside the window", () => {
    assert.deepStrictEqual(paymentRefundEligibility(refundArgs()), { ok: true });
    // One millisecond before the boundary is still eligible.
    assert.deepStrictEqual(
      paymentRefundEligibility(
        refundArgs({ nowMillis: PAID_AT + REFUND_WINDOW_MS - 1 })
      ),
      { ok: true }
    );
  });

  it("uses a strict boundary — exactly 1 hour means the window has passed", () => {
    const atBoundary = paymentRefundEligibility(
      refundArgs({ nowMillis: PAID_AT + REFUND_WINDOW_MS })
    );
    assert.deepStrictEqual(atBoundary.ok, false);
    if (!atBoundary.ok) assert.strictEqual(atBoundary.code, "window_expired");
    assert.strictEqual(
      paymentRefundEligibility(
        refundArgs({ nowMillis: PAID_AT + REFUND_WINDOW_MS + 1 })
      ).ok,
      false
    );
  });

  it("rejects non-paid, unknown, refunded, and refunding statuses", () => {
    for (const [status, code] of [
      ["awaiting_payment", "not_paid"],
      ["processing", "not_paid"],
      ["failed", "not_paid"],
      ["canceled", "not_paid"],
      ["nonsense", "not_paid"],
      ["refunded", "already_refunded"],
      ["refunding", "refund_in_progress"],
    ] as const) {
      const r = paymentRefundEligibility(refundArgs({ status }));
      assert.strictEqual(r.ok, false, status);
      if (!r.ok) assert.strictEqual(r.code, code, status);
    }
  });

  it("rejects missing paidAt and missing Stripe reference, in that order", () => {
    const noPaidAt = paymentRefundEligibility(
      refundArgs({ paidAtMillis: null })
    );
    assert.strictEqual(noPaidAt.ok, false);
    if (!noPaidAt.ok) assert.strictEqual(noPaidAt.code, "missing_paid_at");

    const noRef = paymentRefundEligibility(
      refundArgs({ hasStripePaymentRef: false })
    );
    assert.strictEqual(noRef.ok, false);
    if (!noRef.ok) assert.strictEqual(noRef.code, "missing_stripe_reference");
  });

  it("points staff at the Stripe Dashboard once the window has passed", () => {
    const r = paymentRefundEligibility(
      refundArgs({ nowMillis: PAID_AT + REFUND_WINDOW_MS })
    );
    if (!r.ok) assert.match(r.message, /Stripe Dashboard/);
  });
});

describe("parseRefundBody", () => {
  const good = { reason: "Customer changed their mind", confirmation: "REFUND" };

  it("accepts a reason plus the exact confirmation phrase", () => {
    const r = parseRefundBody(good);
    assert.strictEqual(r.ok, true);
    if (r.ok) assert.strictEqual(r.input.reason, "Customer changed their mind");
  });

  it("trims the reason and rejects empty/overlong reasons", () => {
    const trimmed = parseRefundBody({ ...good, reason: "  duplicate charge  " });
    assert.ok(trimmed.ok && trimmed.input.reason === "duplicate charge");

    for (const reason of ["", "   ", "x".repeat(REFUND_REASON_MAX_LENGTH + 1), undefined, 42]) {
      assert.strictEqual(
        parseRefundBody({ ...good, reason }).ok,
        false,
        `reason ${JSON.stringify(reason)?.slice(0, 30)}`
      );
    }
    assert.strictEqual(
      parseRefundBody({ ...good, reason: "x".repeat(REFUND_REASON_MAX_LENGTH) }).ok,
      true
    );
  });

  it("requires the exact confirmation phrase — case-sensitive", () => {
    for (const confirmation of [undefined, "", "refund", "Refund", "REFUND ", "REFUNDD", 0, true]) {
      assert.strictEqual(
        parseRefundBody({ ...good, confirmation }).ok,
        false,
        `confirmation ${JSON.stringify(confirmation)}`
      );
    }
    assert.strictEqual(REFUND_CONFIRMATION_PHRASE, "REFUND");
  });

  it("ignores any client-supplied amount — the server derives it", () => {
    const r = parseRefundBody({ ...good, amount: "0.01", refundAmountMinor: 1 });
    assert.strictEqual(r.ok, true);
    if (r.ok) assert.deepStrictEqual(r.input, { reason: "Customer changed their mind" });
  });

  it("rejects malformed bodies", () => {
    for (const body of [null, undefined, "REFUND", 42, [1, 2]]) {
      assert.strictEqual(parseRefundBody(body).ok, false, JSON.stringify(body));
    }
  });
});

describe("planRefundClaim", () => {
  const paidRecord = {
    status: "paid",
    amountMinor: 20000,
    currency: "usd",
    paidAt: new Date(PAID_AT),
    stripePaymentIntentId: "pi_123",
    eventCount: 3,
  };

  it("claims a paid payment: refunding status, bumped attempt, audit event", () => {
    const plan = planRefundClaim(paidRecord, "charged in error", PAID_AT + 60000);
    assert.strictEqual(plan.kind, "claim");
    if (plan.kind !== "claim") return;
    assert.strictEqual(plan.updates.status, "refunding");
    assert.strictEqual(plan.updates.refundReason, "charged in error");
    assert.strictEqual(plan.updates.refundFailureMessage, null);
    // The attempt counter is claimed durably — a later attempt's Stripe
    // idempotency key differs, so a released failure can truly retry.
    assert.strictEqual(plan.updates.refundAttempt, 1);
    const second = planRefundClaim(
      { ...paidRecord, refundAttempt: 3 },
      "again",
      PAID_AT + 60000
    );
    assert.strictEqual(
      second.kind === "claim" && second.updates.refundAttempt,
      4
    );
    assert.strictEqual(plan.event.type, "refund_requested");
    assert.strictEqual(plan.event.details?.amountMinor, "20000");
    assert.strictEqual(plan.event.details?.reason, "charged in error");
  });

  it("never re-claims: refunded is idempotent, refunding resumes", () => {
    assert.strictEqual(
      planRefundClaim(
        { ...paidRecord, status: "refunded" },
        "again",
        PAID_AT + 60000
      ).kind,
      "already_refunded"
    );
    assert.strictEqual(
      planRefundClaim(
        { ...paidRecord, status: "refunding" },
        "again",
        PAID_AT + 60000
      ).kind,
      "resume"
    );
  });

  it("rejects ineligible records with a safe code", () => {
    const expired = planRefundClaim(
      paidRecord,
      "too late",
      PAID_AT + REFUND_WINDOW_MS
    );
    assert.strictEqual(expired.kind, "reject");
    if (expired.kind === "reject") {
      assert.strictEqual(expired.code, "window_expired");
      assert.match(expired.message, /Stripe Dashboard/);
    }
    assert.strictEqual(
      planRefundClaim({ ...paidRecord, status: "awaiting_payment" }, "x", PAID_AT + 1).kind,
      "reject"
    );
  });
});

describe("decideRefundFromPaymentIntent", () => {
  const record = {
    status: "refunding",
    amountMinor: 20000,
    currency: "usd",
    stripePaymentIntentId: "pi_123",
  };
  const intent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "pi_123",
    metadata: { paymentId: "pay_1" },
    currency: "usd",
    amount: 20000,
    status: "succeeded",
    latest_charge: { id: "ch_1", amount_refunded: 0, refunds: { data: [] } },
    ...over,
  });

  it("creates a refund for a matching, settled, unrefunded charge", () => {
    const d = decideRefundFromPaymentIntent("pay_1", record, intent());
    assert.strictEqual(d.kind, "create_refund");
  });

  it("rejects when the re-fetched intent does not match the stored reference", () => {
    const wrong = decideRefundFromPaymentIntent(
      "pay_1",
      record,
      intent({ id: "pi_other" })
    );
    assert.strictEqual(wrong.kind, "reject");
    if (wrong.kind === "reject") assert.strictEqual(wrong.code, "intent_mismatch");

    const missing = decideRefundFromPaymentIntent(
      "pay_1",
      { ...record, stripePaymentIntentId: "" },
      intent()
    );
    assert.strictEqual(missing.kind, "reject");
  });

  it("rejects a different internal payment id in Stripe metadata", () => {
    const d = decideRefundFromPaymentIntent(
      "pay_1",
      record,
      intent({ metadata: { paymentId: "pay_other" } })
    );
    assert.strictEqual(d.kind, "reject");
    if (d.kind === "reject") assert.strictEqual(d.code, "payment_mismatch");
    // No metadata at all: the reference check still applied, so allowed.
    assert.strictEqual(
      decideRefundFromPaymentIntent("pay_1", record, intent({ metadata: undefined })).kind,
      "create_refund"
    );
  });

  it("rejects amount and currency disagreement — never trust the browser", () => {
    for (const [mut, code] of [
      [{ amount: 20001 }, "amount_mismatch"],
      [{ currency: "eur" }, "currency_mismatch"],
    ] as const) {
      const d = decideRefundFromPaymentIntent("pay_1", record, intent(mut));
      assert.strictEqual(d.kind, "reject", code);
      if (d.kind === "reject") assert.strictEqual(d.code, code);
    }
  });

  it("rejects an unsettled payment and a charge with no canonical object", () => {
    const unsettled = decideRefundFromPaymentIntent(
      "pay_1",
      record,
      intent({ status: "processing" })
    );
    assert.strictEqual(unsettled.kind, "reject");
    if (unsettled.kind === "reject") assert.strictEqual(unsettled.code, "not_settled");

    const noCharge = decideRefundFromPaymentIntent(
      "pay_1",
      record,
      intent({ latest_charge: null })
    );
    assert.strictEqual(noCharge.kind, "reject");
    if (noCharge.kind === "reject") assert.strictEqual(noCharge.code, "no_charge");
  });

  it("converges instead of re-refunding when Stripe already refunded", () => {
    const d = decideRefundFromPaymentIntent(
      "pay_1",
      record,
      intent({
        latest_charge: {
          id: "ch_1",
          amount_refunded: 20000,
          refunds: { data: [{ id: "re_1" }] },
        },
      })
    );
    assert.strictEqual(d.kind, "already_refunded");
    if (d.kind === "already_refunded") {
      assert.strictEqual(d.stripeRefundId, "re_1");
      assert.strictEqual(d.refundAmountMinor, 20000);
    }
  });

  it("refuses to layer a full refund over an existing partial refund", () => {
    const d = decideRefundFromPaymentIntent(
      "pay_1",
      record,
      intent({
        latest_charge: {
          id: "ch_1",
          amount_refunded: 5000,
          refunds: { data: [{ id: "re_partial" }] },
        },
      })
    );
    assert.strictEqual(d.kind, "reject");
    if (d.kind === "reject") assert.strictEqual(d.code, "partial_refund_exists");
  });

  it("blocks while a refund is still in flight — pending can later succeed or fail", () => {
    for (const status of ["pending", "requires_action"] as const) {
      const d = decideRefundFromPaymentIntent(
        "pay_1",
        record,
        intent({
          latest_charge: {
            id: "ch_1",
            amount_refunded: 0,
            refunds: { data: [{ id: "re_inflight", status }] },
          },
        })
      );
      assert.strictEqual(d.kind, "reject", status);
      if (d.kind === "reject") assert.strictEqual(d.code, "refund_pending");
    }
    // A failed foreign refund does not block — it is final.
    assert.strictEqual(
      decideRefundFromPaymentIntent(
        "pay_1",
        record,
        intent({
          latest_charge: {
            id: "ch_1",
            amount_refunded: 0,
            refunds: { data: [{ id: "re_dead", status: "failed" }] },
          },
        })
      ).kind,
      "create_refund"
    );
  });
});

describe("refund facts and identity", () => {
  it("derives a deterministic Stripe idempotency key per payment attempt", () => {
    assert.strictEqual(refundIdempotencyKey("pay_1", 1), "refund:pay_1:1");
    assert.strictEqual(
      refundIdempotencyKey("pay_1", 1),
      refundIdempotencyKey("pay_1", 1),
      "same attempt → same key on every retry"
    );
    // A fresh claim after a released failure gets a fresh key — Stripe's
    // saved error under the old key must not doom retries.
    assert.notStrictEqual(
      refundIdempotencyKey("pay_1", 1),
      refundIdempotencyKey("pay_1", 2)
    );
    assert.notStrictEqual(
      refundIdempotencyKey("pay_1", 1),
      refundIdempotencyKey("pay_2", 1)
    );
  });

  it("extracts only safe refund facts — ids, amount, currency, status", () => {
    const facts = refundFactsFromStripeRefund({
      id: "re_123",
      amount: 20000,
      currency: "usd",
      status: "succeeded",
      // Anything else Stripe attaches (balance transactions, raw metadata)
      // must not persist.
      balance_transaction: "txn_1",
      raw: { nested: "payload" },
    });
    assert.deepStrictEqual(facts, {
      stripeRefundId: "re_123",
      refundAmountMinor: 20000,
      refundCurrency: "usd",
      stripeRefundStatus: "succeeded",
    });
  });
});

describe("isCollectedForDailyTotal", () => {
  const dayStart = new Date("2026-10-03T00:00:00").getTime();
  const today = dayStart + 12 * 60 * 60 * 1000;
  const yesterday = dayStart - 60 * 1000;

  it("counts paid and in-flight refunds, drops completed refunds", () => {
    for (const [status, expected] of [
      ["paid", true],
      ["refunding", true],
      ["refunded", false],
      ["awaiting_payment", false],
      ["canceled", false],
    ] as const) {
      assert.strictEqual(
        isCollectedForDailyTotal({ status, paidAtMillis: today, dayStartMillis: dayStart }),
        expected,
        status
      );
    }
  });

  it("only counts payments settled today", () => {
    assert.strictEqual(
      isCollectedForDailyTotal({ status: "paid", paidAtMillis: yesterday, dayStartMillis: dayStart }),
      false
    );
    assert.strictEqual(
      isCollectedForDailyTotal({ status: "paid", paidAtMillis: null, dayStartMillis: dayStart }),
      false
    );
  });
});

describe("refund regression safety in Stripe event planning", () => {
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

  it("refunding and refunded are Stripe-terminal — webhooks and refreshes cannot touch them", () => {
    for (const status of ["refunding", "refunded"] as const) {
      for (const transition of ["paid", "processing", "failed", "expired"] as const) {
        for (const source of ["webhook", "manual_refresh"] as const) {
          assert.strictEqual(
            planStripeEventApply(record(status), outcome(transition), source, NOW).apply,
            false,
            `${status} must not regress on ${transition} via ${source}`
          );
        }
      }
    }
  });
});

describe("timestampMillis", () => {
  it("reads Timestamp-like, Date, epoch, and ISO shapes; fails closed", () => {
    const t = PAID_AT;
    assert.strictEqual(timestampMillis(new Date(t)), t);
    assert.strictEqual(timestampMillis({ toMillis: () => t }), t);
    assert.strictEqual(timestampMillis("2026-10-03T12:00:00.000Z"), t);
    assert.strictEqual(timestampMillis(t), t);
    for (const bad of [null, undefined, "not-a-date", {}, NaN]) {
      assert.strictEqual(timestampMillis(bad), null, JSON.stringify(bad));
    }
  });
});

describe("refund event rendering and serialization", () => {
  it("describes refund history entries with amounts and reasons", () => {
    assert.strictEqual(
      describePaymentEvent({
        type: "refund_requested",
        details: { amountMinor: "20000", reason: "charged twice" },
      }),
      "Refund requested — $200.00 (charged twice)"
    );
    assert.strictEqual(
      describePaymentEvent({
        type: "refund_succeeded",
        details: { amountMinor: "20000" },
      }),
      "Refund completed — $200.00"
    );
    assert.strictEqual(
      describePaymentEvent({
        type: "refund_failed",
        details: { message: "card_declined" },
      }),
      "Refund failed — card_declined"
    );
  });

  it("serializes refund facts onto the payment view", () => {
    const view = serializePayment("p1", {
      status: "refunded",
      amountMinor: 20000,
      currency: "usd",
      stripeRefundId: "re_1",
      refundAmountMinor: 20000,
      refundCurrency: "usd",
      refundReason: "changed mind",
      refundedByName: "Sam Admin",
      stripeRefundStatus: "succeeded",
      refundRequestedAt: new Date(PAID_AT),
      refundedAt: new Date(PAID_AT + 1000),
    });
    assert.strictEqual(view.status, "refunded");
    assert.strictEqual(view.stripeRefundId, "re_1");
    assert.strictEqual(view.refundAmountMinor, 20000);
    assert.strictEqual(view.refundReason, "changed mind");
    assert.strictEqual(view.refundedByName, "Sam Admin");
    assert.strictEqual(view.refundedAt, new Date(PAID_AT + 1000).toISOString());
    // The original amount is immutable history — never rewritten.
    assert.strictEqual(view.amountMinor, 20000);
  });

  it("labels the new statuses for staff", () => {
    assert.strictEqual(paymentStatusLabel("refunding"), "Refunding");
    assert.strictEqual(paymentStatusLabel("refunded"), "Refunded");
  });
});

// --- Payment method / rail (issue #206) ---

describe("payment method vocabulary", () => {
  it("accepts exactly card and cash; everything else fails closed", () => {
    assert.strictEqual(isPaymentMethod("card"), true);
    assert.strictEqual(isPaymentMethod("cash"), true);
    for (const bad of ["stripe", "CASH", "", 0, null, undefined, {}]) {
      assert.strictEqual(isPaymentMethod(bad), false, JSON.stringify(bad));
    }
  });

  it("legacy records resolve to card — the rail is explicit, never inferred", () => {
    assert.strictEqual(normalizePaymentMethod("cash"), "cash");
    for (const legacy of [undefined, null, "card", "stripe", 42, {}]) {
      assert.strictEqual(
        normalizePaymentMethod(legacy),
        "card",
        JSON.stringify(legacy)
      );
    }
    assert.strictEqual(paymentMethodLabel("cash"), "Cash");
    assert.strictEqual(paymentMethodLabel(undefined), "Card / Stripe");
  });

  it("serializes the rail onto the view — legacy records read as card", () => {
    const legacy = serializePayment("p1", {
      status: "paid",
      amountMinor: 8000,
      livemode: true,
    });
    assert.strictEqual(legacy.paymentMethod, "card");

    const cash = serializePayment("p2", {
      status: "paid",
      amountMinor: 4000,
      paymentMethod: "cash",
    });
    assert.strictEqual(cash.paymentMethod, "cash");
    // Cash carries no Stripe livemode — the field stays absent so the
    // "Test mode" badge can never appear on a cash record.
    assert.strictEqual(cash.livemode, undefined);
  });
});

describe("parsePaymentCreateBody paymentMethod", () => {
  it("absent means card — earlier clients stay compatible", () => {
    const r = parsePaymentCreateBody(baseBody);
    assert.strictEqual(r.ok, true);
    if (r.ok) assert.strictEqual(r.input.paymentMethod, "card");
  });

  it("accepts an explicit cash rail", () => {
    const r = parsePaymentCreateBody({ ...baseBody, paymentMethod: "cash" });
    assert.strictEqual(r.ok, true);
    if (r.ok) assert.strictEqual(r.input.paymentMethod, "cash");
  });

  it("rejects an unrecognized rail rather than guessing", () => {
    for (const bad of ["stripe", "CASH", "check", 0, true]) {
      assert.strictEqual(
        parsePaymentCreateBody({ ...baseBody, paymentMethod: bad }).ok,
        false,
        JSON.stringify(bad)
      );
    }
  });
});

describe("cash refund eligibility and planning", () => {
  it("cash does not require a Stripe reference — the rest of the rule is identical", () => {
    const r = paymentRefundEligibility(
      refundArgs({ hasStripePaymentRef: false, paymentMethod: "cash" })
    );
    assert.deepStrictEqual(r, { ok: true });
  });

  it("cash failures never point staff at the Stripe Dashboard", () => {
    const expired = paymentRefundEligibility(
      refundArgs({
        hasStripePaymentRef: false,
        paymentMethod: "cash",
        nowMillis: PAID_AT + REFUND_WINDOW_MS,
      })
    );
    assert.strictEqual(expired.ok, false);
    if (!expired.ok) {
      assert.strictEqual(expired.code, "window_expired");
      assert.ok(!/Stripe Dashboard/.test(expired.message));
    }
    const noPaidAt = paymentRefundEligibility(
      refundArgs({ paidAtMillis: null, paymentMethod: "cash" })
    );
    assert.strictEqual(noPaidAt.ok, false);
    if (!noPaidAt.ok) assert.ok(!/Stripe Dashboard/.test(noPaidAt.message));
  });

  it("planCashRefund applies paid→refunded in one step with an audit event", () => {
    const plan = planCashRefund(
      {
        status: "paid",
        paymentMethod: "cash",
        amountMinor: 4000,
        currency: "usd",
        paidAt: new Date(PAID_AT),
      },
      "entered twice by mistake",
      PAID_AT + 60_000
    );
    assert.strictEqual(plan.kind, "apply");
    if (plan.kind !== "apply") return;
    assert.strictEqual(plan.updates.status, "refunded");
    assert.strictEqual(plan.updates.refundAmountMinor, 4000);
    assert.strictEqual(plan.updates.refundCurrency, "usd");
    assert.strictEqual(plan.updates.refundReason, "entered twice by mistake");
    // No Stripe refund identity — the facts are the staff record.
    assert.ok(!("stripeRefundId" in plan.updates));
    assert.strictEqual(plan.event.type, "cash_refund_recorded");
    assert.strictEqual(plan.event.details?.amountMinor, "4000");
    assert.strictEqual(
      describePaymentEvent(plan.event),
      "Cash refund recorded — $40.00 (entered twice by mistake)"
    );
  });

  it("planCashRefund is idempotent and enforces the window", () => {
    const record = {
      status: "paid",
      paymentMethod: "cash",
      amountMinor: 4000,
      paidAt: new Date(PAID_AT),
    };
    assert.strictEqual(
      planCashRefund({ ...record, status: "refunded" }, "x", PAID_AT + 1).kind,
      "already_refunded"
    );
    const late = planCashRefund(record, "x", PAID_AT + REFUND_WINDOW_MS);
    assert.strictEqual(late.kind, "reject");
    if (late.kind === "reject") assert.strictEqual(late.code, "window_expired");
  });

  it("renders the cash payment history event", () => {
    assert.strictEqual(
      describePaymentEvent({ type: "cash_payment_recorded" }),
      "Cash payment recorded"
    );
  });
});
