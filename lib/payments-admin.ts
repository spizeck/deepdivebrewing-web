import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { getStripeClient } from "@/lib/stripe";
import { getStripeWebhookSecret } from "@/lib/stripe-config";
import { siteUrl } from "@/lib/site";
import { logInfo, logWarn } from "@/lib/log";
import {
  buildCheckoutSessionSpec,
  enrichmentFromPaymentIntent,
  isPaymentCancelable,
  normalizePaymentStatus,
  outcomeFromSession,
  PaymentError,
  PaymentNotFoundError,
  planStripeEventApply,
  processStripeEvent,
  resolveStripeEventOutcome,
  PAYMENTS_COLLECTION,
  PAYMENT_EVENTS_SUBCOLLECTION,
  STRIPE_EVENTS_COLLECTION,
  type PaymentCreateInput,
  type PaymentEventDraft,
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
  const spec = buildCheckoutSessionSpec({
    paymentId: ref.id,
    purpose: String(stored.purpose ?? input.purpose),
    description: String(stored.description ?? input.description),
    amountMinor: Number(stored.amountMinor ?? input.amountMinor),
    customerEmail:
      typeof stored.customerEmail === "string"
        ? stored.customerEmail
        : undefined,
    successUrl: `${siteUrl}/pay/complete`,
    cancelUrl: `${siteUrl}/pay/cancelled`,
  });

  // Idempotency key = payment id: a Stripe retry of this call returns the
  // same session instead of creating a second hosted page.
  const session = await getStripeClient().checkout.sessions.create(
    spec as Stripe.Checkout.SessionCreateParams,
    { idempotencyKey: ref.id }
  );
  if (!session.url) {
    throw new PaymentError(
      "Stripe did not return a payment page. Please try again.",
      502
    );
  }

  const batch = db.batch();
  batch.update(ref, {
    status: "awaiting_payment",
    stripeCheckoutSessionId: session.id,
    stripeSessionUrl: session.url,
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
      await getStripeClient().checkout.sessions.expire(sessionId);
    } catch (expireError) {
      // "Already expired" is the benign race — cancel proceeds. Anything
      // else (e.g. the customer already completed) reconciles via the
      // refresh path so the caller sees the true state.
      const session =
        await getStripeClient().checkout.sessions.retrieve(sessionId);
      if (session.status === "expired") {
        // Fall through — the hosted page is dead either way.
      } else if (session.status === "complete") {
        const { paymentId, outcome } = outcomeFromSession(
          session as unknown as Record<string, unknown>,
          session.payment_status === "paid" ? "paid" : "processing"
        );
        await applyOutcome(id, paymentId === id ? outcome : null, "manual_refresh");
        throw new PaymentError(
          "This payment already completed and cannot be canceled.",
          409
        );
      } else {
        throw expireError;
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
      errorName: error instanceof Error ? error.name : "Error",
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

  const session = await getStripeClient().checkout.sessions.retrieve(sessionId);
  const transition =
    session.status === "complete"
      ? session.payment_status === "paid"
        ? "paid"
        : "processing"
      : session.status === "expired"
        ? "expired"
        : null;
  if (!transition) return; // Still open — no state change.

  const { paymentId, outcome } = outcomeFromSession(
    session as unknown as Record<string, unknown>,
    transition
  );
  const targetId = paymentId ?? id;
  if (targetId !== id) {
    logWarn("payment.refresh_id_mismatch", { paymentId: id });
    return;
  }

  const extra =
    transition === "paid" && outcome.paymentIntentId
      ? await fetchPaidEnrichment(outcome.paymentIntentId)
      : {};
  await applyOutcome(id, outcome, "manual_refresh", extra);
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

export interface WebhookResult {
  status: "applied" | "duplicate" | "ignored" | "unknown_payment";
  paymentId: string | null;
  toStatus?: string;
}

// Verifies + processes one webhook delivery. Throws on an invalid signature
// (the route answers 400) — everything else resolves through
// processStripeEvent inside a single Firestore transaction.
export async function handleStripeWebhook(
  rawBody: string,
  signatureHeader: string
): Promise<WebhookResult> {
  const event = getStripeClient().webhooks.constructEvent(
    rawBody,
    signatureHeader,
    getStripeWebhookSecret()
  );

  const resolved = resolveStripeEventOutcome(event);

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
