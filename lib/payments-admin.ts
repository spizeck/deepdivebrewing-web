import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { getStripeClient } from "@/lib/stripe";
import {
  getStripeWebhookSecret,
  resolveCheckoutReturnBaseUrl,
} from "@/lib/stripe-config";
import { logInfo, logWarn } from "@/lib/log";
import {
  assertCheckoutSessionUrl,
  buildCheckoutSessionSpec,
  canonicalSessionDecision,
  enrichmentFromPaymentIntent,
  isPaymentCancelable,
  normalizePaymentStatus,
  outcomeFromSession,
  paymentCreateMatchesRecord,
  paymentIdFromSession,
  PaymentError,
  PaymentNotFoundError,
  planRefundClaim,
  planStripeEventApply,
  processStripeEvent,
  readStripeEventRefs,
  refundFactsFromStripeRefund,
  refundIdempotencyKey,
  resolveCanonicalEventOutcome,
  toPaymentProviderError,
  decideRefundFromPaymentIntent,
  HANDLED_STRIPE_EVENT_TYPES,
  PAYMENTS_COLLECTION,
  PAYMENT_EVENTS_SUBCOLLECTION,
  STRIPE_EVENTS_COLLECTION,
  type PaymentCreateInput,
  type PaymentEventDraft,
  type RefundRequestInput,
  type StripeEventOutcome,
  type StripeEventStore,
  type StripeOutcome,
} from "@/lib/payments-common";
import type Stripe from "stripe";

// Identity the event timeline records — same shape as the trade-lead
// pipeline's actor (display name snapshotted at write time).
export interface PaymentActor {
  uid: string;
  name: string;
}

export function paymentActorOf(actor: {
  token: { uid: string; name?: string; email?: string };
  record: { displayName?: string; email: string };
}): PaymentActor {
  return {
    uid: actor.token.uid,
    name:
      actor.record.displayName?.trim() ||
      actor.token.name?.trim() ||
      actor.token.email?.trim() ||
      actor.record.email,
  };
}

// Admin SDK reads/writes — never imported by client components. `payments`,
// `payments/*/events`, and `stripeEvents` are deny-all in firestore.rules;
// these functions are the only data path and every caller-facing route sits
// behind requireAdminActor (or Stripe signature verification, for the
// webhook).

export function getPaymentsCollection() {
  return getFirebaseAdminDb().collection(PAYMENTS_COLLECTION);
}

// Recent payments only — the workspace is a counter tool, not a ledger.
// Single-field ordering: no composite index needed.
export const PAYMENT_LIST_LIMIT = 100;

export async function listPayments(): Promise<
  { id: string; data: Record<string, unknown> }[]
> {
  const snapshot = await getPaymentsCollection()
    .orderBy("createdAt", "desc")
    .limit(PAYMENT_LIST_LIMIT)
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
}

export async function getPayment(
  id: string
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const doc = await getPaymentsCollection().doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, data: doc.data() ?? {} };
}

export async function listPaymentEvents(
  paymentId: string
): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const snapshot = await getPaymentsCollection()
    .doc(paymentId)
    .collection(PAYMENT_EVENTS_SUBCOLLECTION)
    .orderBy("seq", "asc")
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
}

function eventDoc(
  draft: PaymentEventDraft,
  seq: number,
  actor: PaymentActor | null
) {
  return {
    type: draft.type,
    seq,
    ...(draft.details ? { details: draft.details } : {}),
    ...(actor ? { actorUid: actor.uid, actorName: actor.name } : {}),
    createdAt: FieldValue.serverTimestamp(),
  };
}

// --- Payment creation ---

export interface CreatedPayment {
  id: string;
  data: Record<string, unknown>;
  // True when the POST was an idempotent replay of an earlier request (the
  // document already existed for the clientRequestId).
  replayed: boolean;
}

// Creates the internal record + Stripe Checkout Session.
//
// Duplicate-charge protection is structural: the clientRequestId is both
// the document id and the Stripe idempotency key. A retried POST either
// returns the existing record or resumes a half-finished creation (doc
// exists, session missing) — it can never mint a second session for the
// same logical action.
export async function createAdminPayment(
  input: PaymentCreateInput,
  actor: PaymentActor
): Promise<CreatedPayment> {
  const db = getFirebaseAdminDb();
  const ref = getPaymentsCollection().doc(input.clientRequestId);

  const baseRecord: Record<string, unknown> = {
    purpose: input.purpose,
    description: input.description,
    amountMinor: input.amountMinor,
    currency: "usd",
    customerName: input.customerName,
    ...(input.customerEmail ? { customerEmail: input.customerEmail } : {}),
    ...(input.tourDate ? { tourDate: input.tourDate } : {}),
    ...(input.attendeeCount ? { attendeeCount: input.attendeeCount } : {}),
    ...(input.internalNote ? { internalNote: input.internalNote } : {}),
    status: "created",
    eventCount: 1,
    createdByUid: actor.uid,
    createdByName: actor.name,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  // Read-then-conditional-write inside a transaction so a replay never
  // overwrites: if the doc exists we resume/replay instead of failing.
  const seed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      return { existed: true, data: snap.data() as Record<string, unknown> };
    }
    tx.set(ref, baseRecord);
    tx.set(
      ref.collection(PAYMENT_EVENTS_SUBCOLLECTION).doc(),
      eventDoc({ type: "payment_created" }, 0, actor)
    );
    return { existed: false, data: baseRecord };
  });

  if (seed.existed) {
    // The stored record is authoritative for the charge. A replayed
    // clientRequestId carrying *different* details (staff edited the
    // amount after a lost response) must not silently charge the stored
    // amount — surface a conflict so staff start a fresh payment.
    if (!paymentCreateMatchesRecord(seed.data, input)) {
      throw new PaymentError(
        "A payment with this reference already exists with different details. Start a new payment instead.",
        409
      );
    }

    const status = normalizePaymentStatus(seed.data.status);
    if (status !== "created") {
      // Replay: the earlier request already issued a session (or the payment
      // has since resolved). Return the current record unchanged.
      return { id: ref.id, data: seed.data, replayed: true };
    }
    // Recovery path: the earlier request died after the doc write but before
    // the session was recorded. Continue from the stored record — its fields
    // (not the retried payload) are authoritative for the charge.
  }

  const stored = seed.data;
  // Return/cancel URLs go to the *deployment's* origin — a preview
  // deployment's /pay/* routes exist only on the preview host.
  const returnBase = resolveCheckoutReturnBaseUrl();
  const spec = buildCheckoutSessionSpec({
    paymentId: ref.id,
    purpose: String(stored.purpose ?? input.purpose),
    description: String(stored.description ?? input.description),
    amountMinor: Number(stored.amountMinor ?? input.amountMinor),
    customerEmail:
      typeof stored.customerEmail === "string"
        ? stored.customerEmail
        : undefined,
    successUrl: `${returnBase}/pay/complete`,
    cancelUrl: `${returnBase}/pay/cancelled`,
  });

  // Idempotency key = payment id: a Stripe retry of this call returns the
  // same session instead of creating a second hosted page.
  let session: Stripe.Checkout.Session;
  try {
    session = await getStripeClient().checkout.sessions.create(
      spec as Stripe.Checkout.SessionCreateParams,
      { idempotencyKey: ref.id }
    );
  } catch (error) {
    throw toPaymentProviderError(error);
  }
  // Only Stripe-hosted Checkout URLs may ever reach staff/customers.
  const sessionUrl = assertCheckoutSessionUrl(session.url);

  const batch = db.batch();
  batch.update(ref, {
    status: "awaiting_payment",
    stripeCheckoutSessionId: session.id,
    stripeSessionUrl: sessionUrl,
    ...(session.payment_intent
      ? {
          stripePaymentIntentId:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.payment_intent.id,
        }
      : {}),
    ...(session.customer
      ? {
          stripeCustomerId:
            typeof session.customer === "string"
              ? session.customer
              : session.customer.id,
        }
      : {}),
    livemode: session.livemode,
    sessionExpiresAt: Timestamp.fromMillis(session.expires_at * 1000),
    eventCount: 2,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(
    ref.collection(PAYMENT_EVENTS_SUBCOLLECTION).doc(),
    eventDoc(
      {
        type: "checkout_session_created",
        details: { sessionId: session.id },
      },
      1,
      actor
    )
  );
  await batch.commit();

  const created = await getPayment(ref.id);
  return { id: ref.id, data: created?.data ?? {}, replayed: seed.existed };
}

// --- Staff cancel ---

// Cancels an unpaid payment: expires the hosted session on Stripe first so
// the link dies even if our write fails, then records `canceled`. A Stripe
// `checkout.session.expired` webhook may still arrive later — the state
// machine treats `canceled` as outranking `expired`, so the record keeps
// the staff-canceled meaning.
export async function cancelAdminPayment(
  id: string,
  actor: PaymentActor
): Promise<void> {
  const db = getFirebaseAdminDb();
  const ref = getPaymentsCollection().doc(id);
  const doc = await ref.get();
  if (!doc.exists) throw new PaymentNotFoundError();

  const data = (doc.data() ?? {}) as Record<string, unknown>;
  const status = normalizePaymentStatus(data.status);
  if (!isPaymentCancelable(status)) {
    throw new PaymentError(
      `A ${status === "paid" ? "paid" : "finished"} payment cannot be canceled.`,
      409
    );
  }

  const sessionId =
    typeof data.stripeCheckoutSessionId === "string"
      ? data.stripeCheckoutSessionId
      : null;

  if (sessionId) {
    try {
      await getStripeClient().checkout.sessions.expire(
        sessionId,
        {},
        { idempotencyKey: `${id}:expire` }
      );
    } catch (expireError) {
      // "Already expired" is the benign race — cancel proceeds. Anything
      // else (e.g. the customer already completed) reconciles via the
      // canonical session so the caller sees the true state.
      let session: Stripe.Checkout.Session;
      try {
        session =
          await getStripeClient().checkout.sessions.retrieve(sessionId);
      } catch (error) {
        throw toPaymentProviderError(error);
      }
      const decision = canonicalSessionDecision(
        null,
        session as unknown as Record<string, unknown>
      );
      if (
        decision.kind === "transition" &&
        decision.transition === "expired"
      ) {
        // Fall through — the hosted page is dead either way.
      } else if (session.status === "complete") {
        const transition =
          decision.kind === "transition" ? decision.transition : "processing";
        const { paymentId, outcome } = outcomeFromSession(
          session as unknown as Record<string, unknown>,
          transition
        );
        await applyOutcome(id, paymentId === id ? outcome : null, "manual_refresh");
        throw new PaymentError(
          "This payment already completed and cannot be canceled.",
          409
        );
      } else {
        throw toPaymentProviderError(expireError);
      }
    }
  }

  const base = typeof data.eventCount === "number" ? data.eventCount : 0;
  const batch = db.batch();
  batch.update(ref, {
    status: "canceled",
    canceledAt: FieldValue.serverTimestamp(),
    eventCount: base + 1,
    updatedAt: FieldValue.serverTimestamp(),
  });
  batch.set(
    ref.collection(PAYMENT_EVENTS_SUBCOLLECTION).doc(),
    eventDoc({ type: "payment_canceled" }, base, actor)
  );
  await batch.commit();
}

// --- Reconciliation (manual refresh + webhook shared path) ---

// Applies a Stripe outcome to the stored record inside a transaction —
// same planner the webhook uses, so manual refresh and webhook delivery
// can never diverge.
async function applyOutcome(
  id: string,
  outcome: StripeOutcome | null,
  source: "webhook" | "manual_refresh",
  extraUpdates?: Record<string, unknown>
): Promise<boolean> {
  if (!outcome) return false;
  const ref = getPaymentsCollection().doc(id);
  return getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PaymentNotFoundError();
    const record = (snap.data() ?? {}) as Record<string, unknown>;
    const plan = planStripeEventApply(record, outcome, source);
    if (!plan.apply) return false;
    const base =
      typeof record.eventCount === "number" ? record.eventCount : 0;
    const updates = { ...plan.updates, ...(extraUpdates ?? {}) };
    tx.update(ref, {
      ...updates,
      eventCount: base + plan.events.length,
    });
    plan.events.forEach((draft, index) => {
      tx.set(
        ref.collection(PAYMENT_EVENTS_SUBCOLLECTION).doc(),
        eventDoc(draft, base + index, null)
      );
    });
    return true;
  });
}

// Best-effort receipt/card enrichment for a `paid` transition. Failures are
// logged and skipped — the paid transition itself must not be held hostage
// to a secondary lookup; the refresh action can backfill later.
async function fetchPaidEnrichment(
  paymentIntentId: string
): Promise<Record<string, unknown>> {
  try {
    const intent = await getStripeClient().paymentIntents.retrieve(
      paymentIntentId,
      { expand: ["latest_charge"] }
    );
    return enrichmentFromPaymentIntent(
      intent as unknown as Record<string, unknown>
    );
  } catch (error) {
    logWarn("payment.enrichment_failed", {
      paymentIntentId,
      providerCode: toPaymentProviderError(error).code,
    });
    return {};
  }
}

// Staff-facing "refresh status": re-reads the Checkout Session from Stripe
// and applies the same outcome mapping the webhook would. Idempotent — the
// planner ignores transitions that do not advance the record.
export async function refreshAdminPayment(id: string): Promise<void> {
  const doc = await getPaymentsCollection().doc(id).get();
  if (!doc.exists) throw new PaymentNotFoundError();
  const data = (doc.data() ?? {}) as Record<string, unknown>;
  const sessionId =
    typeof data.stripeCheckoutSessionId === "string"
      ? data.stripeCheckoutSessionId
      : null;
  if (!sessionId) return; // Nothing issued yet — nothing to reconcile.

  let session: Stripe.Checkout.Session;
  try {
    session =
      await getStripeClient().checkout.sessions.retrieve(sessionId);
  } catch (error) {
    throw toPaymentProviderError(error);
  }
  // Manual refresh has no delivery semantics — an open/unsettled session
  // is a no-op rather than a retryable failure.
  const decision = canonicalSessionDecision(
    null,
    session as unknown as Record<string, unknown>
  );
  if (decision.kind !== "transition") return;

  const { paymentId, outcome } = outcomeFromSession(
    session as unknown as Record<string, unknown>,
    decision.transition
  );
  const targetId = paymentId ?? id;
  if (targetId !== id) {
    logWarn("payment.refresh_id_mismatch", { paymentId: id });
    return;
  }

  const extra =
    decision.transition === "paid" && outcome.paymentIntentId
      ? await fetchPaidEnrichment(outcome.paymentIntentId)
      : {};
  const applied = await applyOutcome(id, outcome, "manual_refresh", extra);

  // paid→paid is a no-op for the planner, so a paid record whose
  // enrichment lookup failed at webhook time backfills here.
  if (!applied && data.status === "paid" && !data.receiptUrl) {
    const intentId =
      outcome.paymentIntentId ??
      (typeof data.stripePaymentIntentId === "string"
        ? data.stripePaymentIntentId
        : null);
    const enrich =
      Object.keys(extra).length > 0
        ? extra
        : intentId
          ? await fetchPaidEnrichment(intentId)
          : {};
    if (Object.keys(enrich).length > 0) {
      await getPaymentsCollection()
        .doc(id)
        .update({ ...enrich, updatedAt: FieldValue.serverTimestamp() });
    }
  }
}

// --- Refunds (full refunds only, 1-hour window) ---

// Commit the refunded state inside a transaction. Canonical Stripe truth
// wins over any interleaved internal state: a landed provider refund
// converges `refunding` AND `paid` (a failed attempt's revert may have
// raced a successful provider call), while `refunded` is already settled.
// Other statuses are an anomaly — logged, never written over.
async function commitRefund(
  id: string,
  facts: Record<string, unknown>,
  actor: PaymentActor | null
): Promise<void> {
  const ref = getPaymentsCollection().doc(id);
  await getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PaymentNotFoundError();
    const record = (snap.data() ?? {}) as Record<string, unknown>;
    const status = normalizePaymentStatus(record.status);
    if (status === "refunded") return;
    if (status !== "refunding" && status !== "paid") {
      logWarn("payment.refund_commit_unexpected_status", { paymentId: id });
      return;
    }
    const base =
      typeof record.eventCount === "number" ? record.eventCount : 0;
    const amountMinor =
      typeof facts.refundAmountMinor === "number"
        ? facts.refundAmountMinor
        : record.amountMinor;
    tx.update(ref, {
      status: "refunded",
      ...facts,
      refundFailureMessage: null,
      refundedAt: FieldValue.serverTimestamp(),
      ...(record.refundRequestedAt
        ? {}
        : { refundRequestedAt: FieldValue.serverTimestamp() }),
      eventCount: base + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      ref.collection(PAYMENT_EVENTS_SUBCOLLECTION).doc(),
      eventDoc(
        {
          type: "refund_succeeded",
          details: {
            amountMinor: typeof amountMinor === "number" ? String(amountMinor) : null,
            ...(typeof record.refundReason === "string" && record.refundReason
              ? { reason: record.refundReason }
              : {}),
          },
        },
        base,
        actor
      )
    );
  });
}

// Releases a claimed refund after canonical proof that no refund exists —
// back to `paid` with safe failure metadata + an audit event. Only ever
// applies while `refunding`: a concurrent successful commit is never
// clobbered, and `safeReason` is a machine code, never a raw Stripe
// message.
async function failRefundClaim(
  id: string,
  safeReason: string,
  actor: PaymentActor | null
): Promise<void> {
  const ref = getPaymentsCollection().doc(id);
  await getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PaymentNotFoundError();
    const record = (snap.data() ?? {}) as Record<string, unknown>;
    if (normalizePaymentStatus(record.status) !== "refunding") return;
    const base =
      typeof record.eventCount === "number" ? record.eventCount : 0;
    tx.update(ref, {
      status: "paid",
      refundFailureMessage: safeReason,
      eventCount: base + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      ref.collection(PAYMENT_EVENTS_SUBCOLLECTION).doc(),
      eventDoc(
        {
          type: "refund_failed",
          details: {
            message: safeReason,
            amountMinor:
              typeof record.amountMinor === "number"
                ? String(record.amountMinor)
                : null,
          },
        },
        base,
        actor
      )
    );
  });
}

// Canonical refund position of the charge: the refund facts when Stripe
// shows the money returned, "not_refunded" when provably un-refunded, or
// "unknown" when canonical state cannot be read at all.
async function canonicalRefundPosition(
  paymentId: string,
  record: Record<string, unknown>,
  paymentIntentId: string
): Promise<
  | { kind: "refunded"; facts: Record<string, unknown> }
  | { kind: "not_refunded" }
  | { kind: "unknown" }
> {
  let intent: Stripe.PaymentIntent;
  try {
    intent = await getStripeClient().paymentIntents.retrieve(
      paymentIntentId,
      { expand: ["latest_charge", "latest_charge.refunds"] }
    );
  } catch {
    return { kind: "unknown" };
  }
  const decision = decideRefundFromPaymentIntent(
    paymentId,
    record,
    intent as unknown as Record<string, unknown>
  );
  if (decision.kind === "already_refunded") {
    return {
      kind: "refunded",
      facts: {
        ...(decision.stripeRefundId
          ? { stripeRefundId: decision.stripeRefundId }
          : {}),
        ...(typeof decision.refundAmountMinor === "number"
          ? { refundAmountMinor: decision.refundAmountMinor }
          : {}),
      },
    };
  }
  if (decision.kind === "create_refund") {
    return { kind: "not_refunded" };
  }
  // A reject here still answered a real question: Stripe shows no landed
  // refund for this charge, so the claim may be released.
  return { kind: "not_refunded" };
}

// Issues a full refund for a paid payment inside REFUND_WINDOW_MS.
//
// Safety model (same shape as the rest of the payments flow):
// 1. A Firestore transaction durably claims the refund (`refunding` +
//    `refund_requested`) — two simultaneous requests cannot both proceed,
//    and a retried request resumes instead of re-claiming.
// 2. Provider calls happen outside transactions: the PaymentIntent is
//    re-fetched and every financial fact re-verified against the stored
//    snapshot before any refund is created.
// 3. `refunds.create` runs under the deterministic idempotency key
//    `refund:<paymentId>` — a Stripe-side retry returns the same refund
//    object rather than minting a second one.
// 4. Provider results commit inside a second transaction; a failed
//    provider call releases the claim only after canonical proof that no
//    refund exists (ambiguous outcomes keep `refunding` so the next
//    request reconciles instead of risking a double refund).
export async function refundAdminPayment(
  id: string,
  input: RefundRequestInput,
  actor: PaymentActor
): Promise<void> {
  const db = getFirebaseAdminDb();
  const ref = getPaymentsCollection().doc(id);

  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new PaymentNotFoundError();
    const record = (snap.data() ?? {}) as Record<string, unknown>;
    const plan = planRefundClaim(record, input.reason, Date.now());
    switch (plan.kind) {
      case "already_refunded":
      case "resume":
        return { kind: plan.kind, record };
      case "reject":
        throw new PaymentError(plan.message, 409);
    }
    const base =
      typeof record.eventCount === "number" ? record.eventCount : 0;
    tx.update(ref, {
      ...plan.updates,
      refundedByUid: actor.uid,
      refundedByName: actor.name,
      refundRequestedAt: FieldValue.serverTimestamp(),
      eventCount: base + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(
      ref.collection(PAYMENT_EVENTS_SUBCOLLECTION).doc(),
      eventDoc(plan.event, base, actor)
    );
    return { kind: plan.kind, record };
  });

  // Idempotent replay — the payment is already refunded.
  if (claim.kind === "already_refunded") return;

  const record = claim.record;
  const paymentIntentId =
    typeof record.stripePaymentIntentId === "string" &&
    record.stripePaymentIntentId
      ? record.stripePaymentIntentId
      : null;
  if (!paymentIntentId) {
    // Eligibility requires this reference; a claim without it is a bug —
    // release the claim rather than strand the record in `refunding`.
    await failRefundClaim(id, "missing_stripe_reference", actor);
    throw new PaymentError(
      "This payment has no Stripe payment reference — refund it in the Stripe Dashboard.",
      409
    );
  }

  let intent: Stripe.PaymentIntent;
  try {
    intent = await getStripeClient().paymentIntents.retrieve(
      paymentIntentId,
      { expand: ["latest_charge", "latest_charge.refunds"] }
    );
  } catch (error) {
    throw toPaymentProviderError(error);
  }

  const decision = decideRefundFromPaymentIntent(
    id,
    record,
    intent as unknown as Record<string, unknown>
  );

  if (decision.kind === "already_refunded") {
    // Canonical state shows the money already returned — a Dashboard
    // refund, or a provider retry of our own earlier attempt. Converge to
    // `refunded` with Stripe's facts instead of creating a second refund.
    await commitRefund(
      id,
      {
        ...(decision.stripeRefundId
          ? { stripeRefundId: decision.stripeRefundId }
          : {}),
        ...(typeof decision.refundAmountMinor === "number"
          ? { refundAmountMinor: decision.refundAmountMinor }
          : {}),
      },
      actor
    );
    return;
  }

  if (decision.kind === "reject") {
    // Canonical proof no refund can be created — release the claim and
    // tell staff why (safe message, never a raw Stripe payload).
    await failRefundClaim(id, decision.code, actor);
    throw new PaymentError(decision.message, 409);
  }

  let refund: Stripe.Refund;
  try {
    refund = await getStripeClient().refunds.create(
      {
        payment_intent: paymentIntentId,
        // Full refund only — the amount comes from the stored record,
        // never from the request body.
        amount: record.amountMinor as number,
        metadata: { paymentId: id },
      },
      { idempotencyKey: refundIdempotencyKey(id) }
    );
  } catch (error) {
    // Ambiguous outcome — the refund may exist despite the error. Check
    // canonical state before deciding; never blindly create another
    // refund object.
    const position = await canonicalRefundPosition(id, record, paymentIntentId);
    if (position.kind === "refunded") {
      await commitRefund(id, position.facts, actor);
      return;
    }
    if (position.kind === "not_refunded") {
      await failRefundClaim(id, toPaymentProviderError(error).code, actor);
      throw new PaymentError(
        "Stripe could not complete the refund. The payment is still marked paid — try again or refund it in the Stripe Dashboard.",
        502
      );
    }
    // Canonical state unreadable — keep `refunding` so the next request
    // resumes and reconciles rather than risking a second refund.
    throw toPaymentProviderError(error);
  }

  const refundStatus = refund.status;
  if (refundStatus === "failed" || refundStatus === "canceled") {
    const position = await canonicalRefundPosition(id, record, paymentIntentId);
    if (position.kind === "refunded") {
      await commitRefund(id, position.facts, actor);
      return;
    }
    await failRefundClaim(id, `refund_${refundStatus}`, actor);
    throw new PaymentError(
      "Stripe could not complete the refund. The payment is still marked paid — try again or refund it in the Stripe Dashboard.",
      502
    );
  }

  await commitRefund(
    id,
    refundFactsFromStripeRefund(refund as unknown as Record<string, unknown>),
    actor
  );
}

// --- Stripe webhook ---

// Firestore-backed StripeEventStore: dedupe marker + payment update land in
// one transaction. Reads happen before writes by construction (the
// orchestrator checks the marker, then the payment, then writes).
function makeStripeEventStore(): StripeEventStore {
  const db = getFirebaseAdminDb();
  const markers = db.collection(STRIPE_EVENTS_COLLECTION);
  const payments = db.collection(PAYMENTS_COLLECTION);

  return {
    transact: (work) =>
      db.runTransaction(async (tx) => {
        // getPayment caches the snapshot so updatePayment can continue the
        // `seq` sequence without a second read (all tx reads must precede
        // writes anyway).
        const cache = new Map<string, Record<string, unknown> | null>();
        return work({
          stripeEventProcessed: async (eventId) =>
            (await tx.get(markers.doc(eventId))).exists,
          getPayment: async (paymentId) => {
            const snap = await tx.get(payments.doc(paymentId));
            const data = snap.exists ? (snap.data() ?? {}) : null;
            cache.set(paymentId, data as Record<string, unknown> | null);
            return data as Record<string, unknown> | null;
          },
          updatePayment: async (paymentId, updates, events) => {
            const record = cache.get(paymentId);
            const base =
              typeof record?.eventCount === "number" ? record.eventCount : 0;
            tx.update(payments.doc(paymentId), {
              ...updates,
              eventCount: base + events.length,
            });
            events.forEach((draft, index) => {
              tx.set(
                payments
                  .doc(paymentId)
                  .collection(PAYMENT_EVENTS_SUBCOLLECTION)
                  .doc(),
                eventDoc(draft, base + index, null)
              );
            });
          },
          markStripeEventProcessed: async (eventId, result, meta) => {
            tx.set(markers.doc(eventId), {
              type: meta.eventType,
              ...(meta.paymentId ? { paymentId: meta.paymentId } : {}),
              result,
              processedAt: FieldValue.serverTimestamp(),
            });
          },
        });
      }),
  };
}

// Cheap pre-transaction dedupe check — a replayed delivery exits before the
// canonical Stripe fetch. The authoritative recheck still happens inside
// processStripeEvent's transaction (concurrent deliveries converge there).
async function isStripeEventProcessed(eventId: string): Promise<boolean> {
  const snap = await getFirebaseAdminDb()
    .collection(STRIPE_EVENTS_COLLECTION)
    .doc(eventId)
    .get();
  return snap.exists;
}

export interface WebhookResult {
  status:
    | "applied"
    | "duplicate"
    | "ignored"
    | "unknown_payment"
    | "quarantined"
    | "retry";
  paymentId: string | null;
  toStatus?: string;
}

// Verifies + processes one webhook delivery.
//
// Trust model: the signature proves Stripe sent the event — nothing more.
// Only the event id/type and the session object id are read from the
// payload; the session is then re-fetched from Stripe and *canonical* state
// decides the transition. A payload can therefore never mark a payment
// paid on its own.
//
// Throws on an invalid signature (the route answers 400). Returns "retry"
// when canonical state has not settled (the route answers 500 so Stripe
// redelivers). Everything else resolves through processStripeEvent inside
// a single Firestore transaction.
export async function handleStripeWebhook(
  rawBody: string,
  signatureHeader: string
): Promise<WebhookResult> {
  const stripe = getStripeClient();
  const event = stripe.webhooks.constructEvent(
    rawBody,
    signatureHeader,
    getStripeWebhookSecret()
  );

  const refs = readStripeEventRefs(event);
  let resolved: StripeEventOutcome;

  if (!HANDLED_STRIPE_EVENT_TYPES.has(refs.eventType)) {
    resolved = {
      eventId: refs.eventId,
      eventType: refs.eventType,
      paymentId: null,
      ignoredReason: "unhandled_event_type",
    };
  } else if (!refs.sessionId) {
    resolved = {
      eventId: refs.eventId,
      eventType: refs.eventType,
      paymentId: null,
      ignoredReason: "no_session_reference",
    };
  } else {
    if (refs.eventId && (await isStripeEventProcessed(refs.eventId))) {
      // Replay of a durably processed event — the transaction below sees
      // the marker and exits as "duplicate" without a provider call.
      resolved = {
        eventId: refs.eventId,
        eventType: refs.eventType,
        paymentId: null,
      };
    } else {
      // Canonical re-fetch: the event payload only told us which Checkout
      // Session to look at.
      let session: Stripe.Checkout.Session;
      try {
        session = await stripe.checkout.sessions.retrieve(refs.sessionId);
      } catch (error) {
        throw toPaymentProviderError(error);
      }
      const resolution = resolveCanonicalEventOutcome(
        refs,
        session as unknown as Record<string, unknown>
      );
      if (resolution.kind === "retry") {
        logWarn("stripe_webhook.deferred", {
          eventType: refs.eventType,
          paymentId: paymentIdFromSession(
            session as unknown as Record<string, unknown>
          ),
        });
        return { status: "retry", paymentId: null };
      }
      resolved = resolution.resolved;
    }
  }

  // Paid transitions pick up receipt/card display data before the commit so
  // it lands atomically with the status change.
  if (
    resolved.outcome?.transition === "paid" &&
    resolved.outcome.paymentIntentId
  ) {
    resolved.outcome.extraUpdates = await fetchPaidEnrichment(
      resolved.outcome.paymentIntentId
    );
  }

  const result = await processStripeEvent(resolved, makeStripeEventStore());
  logInfo("stripe_webhook.processed", {
    eventType: resolved.eventType,
    result: result.status,
    paymentId: result.paymentId,
    toStatus: result.toStatus,
  });
  return result;
}
