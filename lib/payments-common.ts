// Shared, dependency-free domain logic for the admin payment workspace
// (Issue #155). Same split as the trade-lead modules: this file is pure and
// safe for client components (no firebase/stripe imports); lib/payments-admin.ts
// wires the server-only Admin SDK and Stripe SDK access.
//
// Money rules: every amount is an integer count of USD cents. The browser
// may suggest an amount (tour product × attendees) but the server always
// re-validates the submitted value — client arithmetic is never trusted.
import { isValidEmail } from "@/lib/email";
import { toIsoString } from "@/lib/admin-serializers";
import { parseCalendarDate, TOUR_PRODUCTS } from "@/lib/whatsapp";

export const PAYMENTS_COLLECTION = "payments";
export const PAYMENT_EVENTS_SUBCOLLECTION = "events";
export const STRIPE_EVENTS_COLLECTION = "stripeEvents";

// The brewery transacts in USD (tour prices are published in USD — see
// TOUR_PRODUCTS). Fixed deliberately: staff never pick a currency, so there
// is nothing to get wrong.
export const PAYMENT_CURRENCY = "usd";
export const PAYMENT_CURRENCY_LABEL = "USD";

// --- Money ---

// Sanity ceiling for a single ad-hoc charge. Well above any realistic tour
// or counter charge; it exists to catch typos like an extra zero.
export const PAYMENT_MAX_AMOUNT_MINOR = 1_000_000; // $10,000.00

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatUsdMinor(minor: number | undefined | null): string {
  if (typeof minor !== "number" || !Number.isFinite(minor)) return "—";
  return usdFormatter.format(minor / 100);
}

// Accepts staff-entered dollar strings ("40", "40.00", "$20") or numbers
// that are exact to the cent. Returns integer minor units or a staff-facing
// error. Rejects anything fractional below a cent.
export function parseAmountMinor(
  raw: unknown
): { ok: true; minor: number } | { ok: false; error: string } {
  let minor: number | null = null;

  if (typeof raw === "string") {
    const value = raw.trim().replace(/^\$\s*/, "");
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
    if (match) {
      minor =
        Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"));
    }
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    const cents = Math.round(raw * 100);
    if (Math.abs(raw * 100 - cents) < 1e-9) minor = cents;
  }

  if (minor === null || !Number.isInteger(minor)) {
    return { ok: false, error: "Enter a valid amount (e.g. 40 or 40.00)." };
  }
  if (minor <= 0) {
    return { ok: false, error: "Amount must be greater than zero." };
  }
  if (minor > PAYMENT_MAX_AMOUNT_MINOR) {
    return {
      ok: false,
      error: `Amount cannot exceed ${formatUsdMinor(PAYMENT_MAX_AMOUNT_MINOR)}.`,
    };
  }
  return { ok: true, minor };
}

// --- Purpose / quick-picks ---

export interface PaymentPurpose {
  value: string;
  label: string;
  // Suggested per-person price where a canonical one exists (the published
  // tour products in lib/whatsapp.ts). Staff can always override the amount.
  perPersonMinor?: number;
}

// `label` and `perPersonMinor` for the tour purposes are derived from
// TOUR_PRODUCTS — the same canonical prices the public site advertises — so
// the payment quick-picks can never drift from published pricing.
export const PAYMENT_PURPOSES: readonly PaymentPurpose[] = [
  {
    value: "brewery_tour",
    label: TOUR_PRODUCTS.breweryTour.label,
    perPersonMinor: TOUR_PRODUCTS.breweryTour.priceUsd * 100,
  },
  {
    value: "brewery_tour_tasting",
    label: TOUR_PRODUCTS.breweryTourTasting.label,
    perPersonMinor: TOUR_PRODUCTS.breweryTourTasting.priceUsd * 100,
  },
  { value: "additional_guests", label: "Additional guest(s)" },
  { value: "private_tour", label: "Private tour" },
  { value: "other", label: "Other" },
];

const PAYMENT_PURPOSE_VALUES: ReadonlySet<string> = new Set(
  PAYMENT_PURPOSES.map((p) => p.value)
);

export function isPaymentPurpose(value: unknown): value is string {
  return typeof value === "string" && PAYMENT_PURPOSE_VALUES.has(value);
}

export function paymentPurposeLabel(value: unknown): string {
  return (
    PAYMENT_PURPOSES.find((p) => p.value === value)?.label ??
    (typeof value === "string" && value ? value : "Other")
  );
}

// Quick-fill suggestion only — never submitted back as an authoritative
// total. Returns null when the purpose has no canonical per-person price or
// the attendee count is absent.
export function suggestedAmountMinor(
  purpose: string,
  attendeeCount: number | undefined
): number | null {
  const entry = PAYMENT_PURPOSES.find((p) => p.value === purpose);
  if (!entry?.perPersonMinor || !attendeeCount || attendeeCount < 1) {
    return null;
  }
  return entry.perPersonMinor * attendeeCount;
}

// --- Status model ---

// `created` is the brief window where the internal record exists but the
// Stripe Checkout Session is still being made — normally invisible, but it
// is what a mid-creation failure recovery path resumes from.
export const PAYMENT_STATUSES = [
  { value: "created", label: "Setting up" },
  { value: "awaiting_payment", label: "Awaiting payment" },
  { value: "processing", label: "Processing" },
  { value: "paid", label: "Paid" },
  { value: "failed", label: "Failed" },
  { value: "expired", label: "Expired" },
  { value: "canceled", label: "Canceled" },
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]["value"];

const PAYMENT_STATUS_VALUES: ReadonlySet<string> = new Set(
  PAYMENT_STATUSES.map((s) => s.value)
);

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === "string" && PAYMENT_STATUS_VALUES.has(value);
}

export function normalizePaymentStatus(value: unknown): PaymentStatus {
  return isPaymentStatus(value) ? value : "created";
}

export function paymentStatusLabel(value: unknown): string {
  const status = normalizePaymentStatus(value);
  return PAYMENT_STATUSES.find((s) => s.value === status)?.label ?? status;
}

// A live Checkout Session exists and the customer can still pay on it.
export function isPaymentPayable(status: PaymentStatus): boolean {
  return status === "awaiting_payment";
}

// Staff may cancel only while no money is moving: the record exists and a
// session may or may not have been issued yet.
export function isPaymentCancelable(status: PaymentStatus): boolean {
  return status === "created" || status === "awaiting_payment";
}

// Statuses a Stripe transition may never overwrite. `paid` is also
// absorbing for Stripe events but can later be superseded by refund states
// (future work) — refunds are deliberately not in this model yet.
function isStripeTerminal(status: PaymentStatus): boolean {
  return status === "paid" || status === "expired" || status === "canceled";
}

// --- Records / views ---

export interface PaymentRecord {
  purpose?: string;
  description?: string;
  amountMinor?: number;
  currency?: string;
  customerName?: string;
  customerEmail?: string;
  tourDate?: string;
  attendeeCount?: number;
  internalNote?: string;
  status?: string;
  livemode?: boolean;
  eventCount?: number;
  createdByUid?: string;
  createdByName?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  stripeCheckoutSessionId?: string;
  stripeSessionUrl?: string;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  stripeCustomerId?: string;
  sessionExpiresAt?: unknown;
  receiptUrl?: string;
  paymentMethodBrand?: string;
  paymentMethodLast4?: string;
  paidAt?: unknown;
  failedAt?: unknown;
  expiredAt?: unknown;
  canceledAt?: unknown;
  failureMessage?: string;
}

// Serialized view returned to the admin client — ISO strings, no
// Firestore-shaped values cross the API boundary.
export interface PaymentView {
  id: string;
  purpose: string;
  description: string;
  amountMinor: number;
  currency: string;
  customerName: string;
  customerEmail?: string;
  tourDate?: string;
  attendeeCount?: number;
  internalNote?: string;
  status: PaymentStatus;
  livemode: boolean;
  createdByUid: string;
  createdByName: string;
  createdAt?: string;
  updatedAt?: string;
  stripeCheckoutSessionId?: string;
  stripeSessionUrl?: string;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  stripeCustomerId?: string;
  sessionExpiresAt?: string;
  receiptUrl?: string;
  paymentMethodBrand?: string;
  paymentMethodLast4?: string;
  paidAt?: string;
  failedAt?: string;
  expiredAt?: string;
  canceledAt?: string;
  failureMessage?: string;
}

export function serializePayment(
  id: string,
  data: Record<string, unknown>
): PaymentView {
  const str = (key: string) => {
    const v = data[key];
    return typeof v === "string" ? v : "";
  };
  const optStr = (key: string) => {
    const v = data[key];
    return typeof v === "string" && v ? v : undefined;
  };
  return {
    id,
    purpose: str("purpose") || "other",
    description: str("description"),
    amountMinor:
      typeof data.amountMinor === "number" ? data.amountMinor : 0,
    currency: str("currency") || PAYMENT_CURRENCY,
    customerName: str("customerName"),
    customerEmail: optStr("customerEmail"),
    tourDate: optStr("tourDate"),
    attendeeCount:
      typeof data.attendeeCount === "number" ? data.attendeeCount : undefined,
    internalNote: optStr("internalNote"),
    status: normalizePaymentStatus(data.status),
    livemode: data.livemode === true,
    createdByUid: str("createdByUid"),
    createdByName: str("createdByName"),
    createdAt: toIsoString(data.createdAt),
    updatedAt: toIsoString(data.updatedAt),
    stripeCheckoutSessionId: optStr("stripeCheckoutSessionId"),
    stripeSessionUrl: optStr("stripeSessionUrl"),
    stripePaymentIntentId: optStr("stripePaymentIntentId"),
    stripeChargeId: optStr("stripeChargeId"),
    stripeCustomerId: optStr("stripeCustomerId"),
    sessionExpiresAt: toIsoString(data.sessionExpiresAt),
    receiptUrl: optStr("receiptUrl"),
    paymentMethodBrand: optStr("paymentMethodBrand"),
    paymentMethodLast4: optStr("paymentMethodLast4"),
    paidAt: toIsoString(data.paidAt),
    failedAt: toIsoString(data.failedAt),
    expiredAt: toIsoString(data.expiredAt),
    canceledAt: toIsoString(data.canceledAt),
    failureMessage: optStr("failureMessage"),
  };
}

// --- Payment events (audit trail) ---

export const PAYMENT_EVENT_TYPES = [
  "payment_created",
  "checkout_session_created",
  "payment_processing",
  "payment_succeeded",
  "payment_failed",
  "session_expired",
  "payment_canceled",
] as const;

export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

export interface PaymentEventDraft {
  type: PaymentEventType;
  details?: Record<string, string | null>;
}

export interface PaymentEventView {
  id: string;
  type: string;
  seq?: number;
  actorUid?: string;
  actorName?: string;
  details?: Record<string, unknown>;
  createdAt?: string;
}

export function serializePaymentEvent(
  id: string,
  data: Record<string, unknown>
): PaymentEventView {
  const optStr = (key: string) => {
    const v = data[key];
    return typeof v === "string" && v ? v : undefined;
  };
  const details = data.details;
  return {
    id,
    type: optStr("type") ?? "payment_created",
    seq: typeof data.seq === "number" ? data.seq : undefined,
    actorUid: optStr("actorUid"),
    actorName: optStr("actorName"),
    details:
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : undefined,
    createdAt: toIsoString(data.createdAt),
  };
}

// One readable line per history entry for the detail timeline.
export function describePaymentEvent(
  event: Pick<PaymentEventView, "type" | "details">
): string {
  const details = event.details ?? {};
  const detailStr = (key: string) =>
    typeof details[key] === "string" ? (details[key] as string) : null;
  const source = detailStr("source") === "manual_refresh" ? " (manual refresh)" : "";
  switch (event.type) {
    case "payment_created":
      return "Payment created";
    case "checkout_session_created":
      return "Payment link created";
    case "payment_processing":
      return `Payment submitted — waiting for the bank to confirm${source}`;
    case "payment_succeeded":
      return `Payment succeeded${source}`;
    case "payment_failed": {
      const msg = detailStr("message");
      return msg ? `Payment failed — ${msg}` : `Payment failed${source}`;
    }
    case "session_expired":
      return `Payment link expired${source}`;
    case "payment_canceled":
      return "Payment canceled by staff";
    default:
      return event.type;
  }
}

// --- Creation input validation ---

export class PaymentError extends Error {
  public readonly clientSafe = true;
  constructor(
    message: string,
    public status: number = 400
  ) {
    super(message);
  }
}

export class PaymentNotFoundError extends PaymentError {
  constructor() {
    super("Payment not found.", 404);
  }
}

export const PAYMENT_FIELD_LIMITS = {
  customerName: 200,
  customerEmail: 320,
  description: 250,
  internalNote: 1000,
} as const;

export const PAYMENT_MAX_ATTENDEES = 200;
// A tour date is a calendar-day hint for reconciliation, not a booking —
// allow generous slack in either direction (a charge can follow the tour).
const TOUR_DATE_MAX_YEARS_AWAY = 2;

// The idempotency handle the browser generates once per "take payment"
// session. It is the payment's document id, so a retried POST can never
// create a second charge for the same logical action.
export const CLIENT_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PaymentCreateInput {
  clientRequestId: string;
  purpose: string;
  description: string;
  amountMinor: number;
  customerName: string;
  customerEmail?: string;
  tourDate?: string;
  attendeeCount?: number;
  internalNote?: string;
}

export function parsePaymentCreateBody(
  body: unknown
): { ok: true; input: PaymentCreateInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body." };
  }
  const raw = body as Record<string, unknown>;
  const str = (key: string) =>
    typeof raw[key] === "string" ? (raw[key] as string).trim() : "";

  const clientRequestId = str("clientRequestId");
  if (!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
    return { ok: false, error: "Missing or invalid payment request id." };
  }

  const purpose = str("purpose");
  if (!isPaymentPurpose(purpose)) {
    return { ok: false, error: "Choose a payment purpose." };
  }

  const description = str("description");
  if (!description) {
    return { ok: false, error: "Description is required." };
  }
  if (description.length > PAYMENT_FIELD_LIMITS.description) {
    return { ok: false, error: "Description is too long." };
  }

  const amount = parseAmountMinor(raw.amount);
  if (!amount.ok) return amount;

  const customerName = str("customerName");
  if (!customerName) {
    return { ok: false, error: "Customer name is required." };
  }
  if (customerName.length > PAYMENT_FIELD_LIMITS.customerName) {
    return { ok: false, error: "Customer name is too long." };
  }

  const customerEmail = str("customerEmail");
  if (customerEmail) {
    if (!isValidEmail(customerEmail)) {
      return { ok: false, error: "Enter a valid email address." };
    }
    if (customerEmail.length > PAYMENT_FIELD_LIMITS.customerEmail) {
      return { ok: false, error: "Email is too long." };
    }
  }

  const internalNote = str("internalNote");
  if (internalNote.length > PAYMENT_FIELD_LIMITS.internalNote) {
    return { ok: false, error: "Internal note is too long." };
  }

  let tourDate: string | undefined;
  const tourDateRaw = str("tourDate");
  if (tourDateRaw) {
    const date = parseCalendarDate(tourDateRaw);
    if (!date) {
      return { ok: false, error: "Tour date must be a valid date." };
    }
    const today = new Date();
    const earliest = today.getFullYear() - TOUR_DATE_MAX_YEARS_AWAY;
    const latest = today.getFullYear() + TOUR_DATE_MAX_YEARS_AWAY;
    if (date.year < earliest || date.year > latest) {
      return { ok: false, error: "Tour date is outside the allowed range." };
    }
    // Canonical re-serialization keeps storage strictly YYYY-MM-DD.
    const pad = (n: number) => String(n).padStart(2, "0");
    tourDate = `${date.year}-${pad(date.month)}-${pad(date.day)}`;
  }

  let attendeeCount: number | undefined;
  if (raw.attendeeCount !== undefined && raw.attendeeCount !== null && raw.attendeeCount !== "") {
    const count = Number(raw.attendeeCount);
    if (!Number.isInteger(count) || count < 1 || count > PAYMENT_MAX_ATTENDEES) {
      return {
        ok: false,
        error: `Attendee count must be a whole number between 1 and ${PAYMENT_MAX_ATTENDEES}.`,
      };
    }
    attendeeCount = count;
  }

  return {
    ok: true,
    input: {
      clientRequestId,
      purpose,
      description,
      amountMinor: amount.minor,
      customerName,
      customerEmail: customerEmail || undefined,
      tourDate,
      attendeeCount,
      internalNote: internalNote || undefined,
    },
  };
}

// --- Checkout Session construction ---

// Minimal structural shape of the Stripe SessionCreateParams we build —
// the server layer casts it onto the SDK type. Declared here (without the
// Stripe import) so the exact payload sent to Stripe is unit-testable.
export interface CheckoutSessionSpec {
  mode: "payment";
  client_reference_id: string;
  customer_email?: string;
  line_items: {
    quantity: number;
    price_data: {
      currency: string;
      unit_amount: number;
      product_data: { name: string };
    };
  }[];
  metadata: Record<string, string>;
  payment_intent_data: {
    metadata: Record<string, string>;
    description: string;
  };
  success_url: string;
  cancel_url: string;
}

// Builds the hosted Checkout Session parameters from the *stored* payment
// record — never from browser-submitted totals. Metadata carries only the
// internal id + purpose: the id is the canonical correlation handle and no
// customer PII belongs in Stripe metadata.
export function buildCheckoutSessionSpec(args: {
  paymentId: string;
  purpose: string;
  description: string;
  amountMinor: number;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
}): CheckoutSessionSpec {
  return {
    mode: "payment",
    client_reference_id: args.paymentId,
    ...(args.customerEmail ? { customer_email: args.customerEmail } : {}),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: PAYMENT_CURRENCY,
          unit_amount: args.amountMinor,
          product_data: { name: args.description },
        },
      },
    ],
    metadata: { paymentId: args.paymentId, purpose: args.purpose },
    payment_intent_data: {
      metadata: { paymentId: args.paymentId, purpose: args.purpose },
      description: args.description,
    },
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  };
}

// --- Stripe event → internal outcome ---

export type StripeTransition = "paid" | "processing" | "failed" | "expired";

// What a Stripe-side object state means for our record. The webhook and the
// manual "refresh status" action both produce this shape, so reconciliation
// follows one path regardless of how the state arrived.
export interface StripeOutcome {
  transition: StripeTransition;
  sessionId?: string;
  paymentIntentId?: string;
  stripeCustomerId?: string;
  sessionExpiresAtMillis?: number;
  failureMessage?: string;
  // Additional safe fields merged into the document when the transition
  // applies — e.g. receipt URL / card brand+last4 fetched from the
  // PaymentIntent on a `paid` transition (see enrichmentFromPaymentIntent).
  extraUpdates?: Record<string, unknown>;
}

export interface StripeEventOutcome {
  eventId: string;
  eventType: string;
  paymentId: string | null;
  outcome?: StripeOutcome;
  // Why the event does not map to a transition (unhandled type, no payment
  // reference). Still dedupe-marked so replays stay quiet.
  ignoredReason?: string;
}

// Stripe object fields are read defensively — ids may arrive as strings or
// expanded objects depending on the API surface.
function stripeIdOf(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string"
  ) {
    return (value as { id: string }).id;
  }
  return undefined;
}

// Maps a checkout.session-shaped object to the internal outcome. Shared by
// the webhook (event.data.object) and the refresh action (retrieved session)
// so both reconcile identically.
export function outcomeFromSession(
  session: Record<string, unknown>,
  transition: StripeTransition,
  failureMessage?: string
): { paymentId: string | null; outcome: StripeOutcome } {
  const metadata = session.metadata;
  const paymentId =
    (metadata &&
    typeof metadata === "object" &&
    typeof (metadata as Record<string, unknown>).paymentId === "string"
      ? ((metadata as Record<string, unknown>).paymentId as string)
      : undefined) ??
    (typeof session.client_reference_id === "string"
      ? session.client_reference_id
      : undefined) ??
    null;

  const expiresAt =
    typeof session.expires_at === "number" && session.expires_at > 0
      ? session.expires_at * 1000
      : undefined;

  return {
    paymentId,
    outcome: {
      transition,
      sessionId: stripeIdOf(session.id) ?? (typeof session.id === "string" ? session.id : undefined),
      paymentIntentId: stripeIdOf(session.payment_intent),
      stripeCustomerId: stripeIdOf(session.customer),
      sessionExpiresAtMillis: expiresAt,
      failureMessage,
    },
  };
}

// Resolves a verified Stripe webhook event to the outcome it implies.
// Only the events we subscribe to produce transitions; everything else is
// acknowledged-and-ignored so stray subscriptions cannot corrupt state.
export function resolveStripeEventOutcome(event: {
  id?: unknown;
  type?: unknown;
  data?: unknown;
}): StripeEventOutcome {
  const eventId = typeof event.id === "string" ? event.id : "";
  const eventType = typeof event.type === "string" ? event.type : "";
  const session =
    event.data &&
    typeof event.data === "object" &&
    (event.data as { object?: unknown }).object &&
    typeof (event.data as { object?: unknown }).object === "object"
      ? ((event.data as { object: Record<string, unknown> })
          .object as Record<string, unknown>)
      : {};

  let transition: StripeTransition | null = null;
  if (eventType === "checkout.session.completed") {
    transition =
      session.payment_status === "paid" ? "paid" : "processing";
  } else if (eventType === "checkout.session.async_payment_succeeded") {
    transition = "paid";
  } else if (eventType === "checkout.session.async_payment_failed") {
    transition = "failed";
  } else if (eventType === "checkout.session.expired") {
    transition = "expired";
  }

  if (!transition) {
    return {
      eventId,
      eventType,
      paymentId: null,
      ignoredReason: "unhandled_event_type",
    };
  }

  const { paymentId, outcome } = outcomeFromSession(session, transition);
  if (!paymentId) {
    return {
      eventId,
      eventType,
      paymentId: null,
      ignoredReason: "no_payment_reference",
    };
  }
  return { eventId, eventType, paymentId, outcome };
}

// --- Transition planning ---

export interface StripeApplyPlan {
  apply: boolean;
  updates: Record<string, unknown>;
  events: PaymentEventDraft[];
  // The status the plan would produce — for logging/response context.
  toStatus?: PaymentStatus;
}

// Pure state machine: given the stored record and a Stripe outcome, decide
// the field updates + audit events. Out-of-order and duplicate deliveries
// are absorbed here — a Stripe-terminal record never regresses, and a
// transition to the current status is a no-op.
export function planStripeEventApply(
  record: PaymentRecord,
  outcome: StripeOutcome,
  source: "webhook" | "manual_refresh" = "webhook",
  now: Date = new Date()
): StripeApplyPlan {
  const current = normalizePaymentStatus(record.status);
  const target = outcome.transition;
  const sourceDetail: Record<string, string> =
    source === "manual_refresh" ? { source } : {};

  // Statuses each transition may legitimately overwrite. `paid` wins over
  // everything except an existing `paid` — money captured is authoritative.
  const allowed: Record<StripeTransition, ReadonlySet<PaymentStatus>> = {
    paid: new Set<PaymentStatus>([
      "created",
      "awaiting_payment",
      "processing",
      "failed",
      "expired",
      "canceled",
    ]),
    processing: new Set<PaymentStatus>(["created", "awaiting_payment", "failed"]),
    failed: new Set<PaymentStatus>([
      "created",
      "awaiting_payment",
      "processing",
    ]),
    // `canceled` outranks `expired`: staff canceled the link before Stripe
    // reported the session expired, and both mean "cannot be paid".
    expired: new Set<PaymentStatus>(["created", "awaiting_payment", "failed"]),
  };

  if (isStripeTerminal(current) && target !== "paid") {
    return { apply: false, updates: {}, events: [] };
  }
  if (!allowed[target].has(current)) {
    return { apply: false, updates: {}, events: [] };
  }

  const updates: Record<string, unknown> = { status: target, updatedAt: now };
  const events: PaymentEventDraft[] = [];

  if (outcome.sessionId && !record.stripeCheckoutSessionId) {
    updates.stripeCheckoutSessionId = outcome.sessionId;
  }
  if (outcome.paymentIntentId && record.stripePaymentIntentId !== outcome.paymentIntentId) {
    updates.stripePaymentIntentId = outcome.paymentIntentId;
  }
  if (outcome.stripeCustomerId && !record.stripeCustomerId) {
    updates.stripeCustomerId = outcome.stripeCustomerId;
  }
  if (outcome.sessionExpiresAtMillis && !record.sessionExpiresAt) {
    updates.sessionExpiresAt = new Date(outcome.sessionExpiresAtMillis);
  }
  if (outcome.extraUpdates) {
    Object.assign(updates, outcome.extraUpdates);
  }

  switch (target) {
    case "paid":
      updates.paidAt = now;
      events.push({ type: "payment_succeeded", details: sourceDetail });
      break;
    case "processing":
      events.push({ type: "payment_processing", details: sourceDetail });
      break;
    case "failed":
      updates.failedAt = now;
      if (outcome.failureMessage) {
        updates.failureMessage = outcome.failureMessage;
      }
      events.push({
        type: "payment_failed",
        details: {
          ...sourceDetail,
          ...(outcome.failureMessage
            ? { message: outcome.failureMessage }
            : {}),
        },
      });
      break;
    case "expired":
      updates.expiredAt = now;
      events.push({ type: "session_expired", details: sourceDetail });
      break;
  }

  return { apply: true, updates, events, toStatus: target };
}

// --- Payment enrichment (receipt/card display data) ---

// Safe display metadata extracted from a retrieved PaymentIntent's latest
// charge. Only brand/last4 + receipt URL are stored — Stripe's own hosted
// receipt page; never PAN/CVC or raw payloads.
export function enrichmentFromPaymentIntent(
  intent: Record<string, unknown>
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  const charge = intent.latest_charge;
  if (charge && typeof charge === "object") {
    const c = charge as Record<string, unknown>;
    const chargeId = stripeIdOf(c.id);
    if (chargeId) updates.stripeChargeId = chargeId;
    if (typeof c.receipt_url === "string" && c.receipt_url) {
      updates.receiptUrl = c.receipt_url;
    }
    const details = c.payment_method_details;
    if (details && typeof details === "object") {
      const card = (details as Record<string, unknown>).card;
      if (card && typeof card === "object") {
        const cardObj = card as Record<string, unknown>;
        if (typeof cardObj.brand === "string" && cardObj.brand) {
          updates.paymentMethodBrand = cardObj.brand;
        }
        if (typeof cardObj.last4 === "string" && cardObj.last4) {
          updates.paymentMethodLast4 = cardObj.last4;
        }
      }
    }
  }
  return updates;
}

// --- Webhook orchestration (injected store for testability) ---

// The transaction surface the pure orchestrator needs. The server
// implementation (lib/payments-admin.ts) backs it with a Firestore
// transaction — reads-then-writes order is preserved by construction.
export interface StripeEventTx {
  stripeEventProcessed(eventId: string): Promise<boolean>;
  getPayment(paymentId: string): Promise<Record<string, unknown> | null>;
  updatePayment(
    paymentId: string,
    updates: Record<string, unknown>,
    events: PaymentEventDraft[]
  ): Promise<void>;
  markStripeEventProcessed(
    eventId: string,
    result: "applied" | "ignored" | "unknown_payment",
    meta: { eventType: string; paymentId: string | null }
  ): Promise<void>;
}

export interface StripeEventStore {
  transact<R>(work: (tx: StripeEventTx) => Promise<R>): Promise<R>;
}

export interface StripeEventResult {
  status: "applied" | "duplicate" | "ignored" | "unknown_payment";
  paymentId: string | null;
  toStatus?: PaymentStatus;
}

// Single delivery path for verified webhook events: dedupe → load record →
// plan → apply → mark. Idempotent end to end: a replayed event finds its
// marker and exits before touching the payment.
export async function processStripeEvent(
  resolved: StripeEventOutcome,
  store: StripeEventStore
): Promise<StripeEventResult> {
  return store.transact(async (tx) => {
    if (!resolved.eventId) {
      return { status: "ignored", paymentId: resolved.paymentId };
    }
    if (await tx.stripeEventProcessed(resolved.eventId)) {
      return { status: "duplicate", paymentId: resolved.paymentId };
    }

    const meta = { eventType: resolved.eventType, paymentId: resolved.paymentId };

    if (!resolved.paymentId || !resolved.outcome) {
      await tx.markStripeEventProcessed(resolved.eventId, "ignored", meta);
      return { status: "ignored", paymentId: resolved.paymentId };
    }

    const record = await tx.getPayment(resolved.paymentId);
    if (!record) {
      // The event belongs to some other Stripe object (or a deleted record)
      // — acknowledge it so Stripe does not retry forever.
      await tx.markStripeEventProcessed(
        resolved.eventId,
        "unknown_payment",
        meta
      );
      return { status: "unknown_payment", paymentId: resolved.paymentId };
    }

    const plan = planStripeEventApply(record, resolved.outcome, "webhook");
    if (plan.apply) {
      await tx.updatePayment(resolved.paymentId, plan.updates, plan.events);
    }
    await tx.markStripeEventProcessed(
      resolved.eventId,
      plan.apply ? "applied" : "ignored",
      meta
    );
    return {
      status: plan.apply ? "applied" : "ignored",
      paymentId: resolved.paymentId,
      toStatus: plan.toStatus,
    };
  });
}
