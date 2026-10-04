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
  { value: "refunding", label: "Refunding" },
  { value: "refunded", label: "Refunded" },
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
// absorbing for Stripe events — a repeated canonical `paid` outcome is a
// no-op rather than a regression. `refunding`/`refunded` sit here too:
// the Checkout Session already settled, so session-level events arriving
// during or after a refund are meaningless and must not touch the record.
function isStripeTerminal(status: PaymentStatus): boolean {
  return (
    status === "paid" ||
    status === "refunding" ||
    status === "refunded" ||
    status === "expired" ||
    status === "canceled"
  );
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
  // Refund facts (full refunds only — see the Refunds section below).
  // Set by the admin refund flow; the original charge fields are never
  // rewritten once settled.
  stripeRefundId?: string;
  refundAmountMinor?: number;
  refundCurrency?: string;
  refundReason?: string;
  refundedByUid?: string;
  refundedByName?: string;
  refundRequestedAt?: unknown;
  refundedAt?: unknown;
  stripeRefundStatus?: string;
  // Durable attempt counter scoped by the claim — drives the Stripe
  // idempotency key (`refund:<id>:<attempt>`). Incremented per claim,
  // never by a resume.
  refundAttempt?: number;
  // Safe provider category for the last failed refund attempt (never a
  // raw Stripe message).
  refundFailureMessage?: string;
  // Set when Stripe's canonical state contradicted the stored snapshot
  // (session/amount/currency) — settlement refused until staff review.
  reconciliationIssue?: string;
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
  reconciliationIssue?: string;
  stripeRefundId?: string;
  refundAmountMinor?: number;
  refundCurrency?: string;
  refundReason?: string;
  refundedByName?: string;
  refundRequestedAt?: string;
  refundedAt?: string;
  stripeRefundStatus?: string;
  refundFailureMessage?: string;
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
    reconciliationIssue: optStr("reconciliationIssue"),
    stripeRefundId: optStr("stripeRefundId"),
    refundAmountMinor:
      typeof data.refundAmountMinor === "number"
        ? data.refundAmountMinor
        : undefined,
    refundCurrency: optStr("refundCurrency"),
    refundReason: optStr("refundReason"),
    refundedByName: optStr("refundedByName"),
    refundRequestedAt: toIsoString(data.refundRequestedAt),
    refundedAt: toIsoString(data.refundedAt),
    stripeRefundStatus: optStr("stripeRefundStatus"),
    refundFailureMessage: optStr("refundFailureMessage"),
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
  "reconciliation_mismatch",
  "refund_requested",
  "refund_succeeded",
  "refund_failed",
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
    case "reconciliation_mismatch": {
      const reason = detailStr("reason");
      return `Payment flagged — Stripe's report did not match this charge${reason ? ` (${reason})` : ""}. Do not treat it as paid without review`;
    }
    case "refund_requested": {
      const reason = detailStr("reason");
      return `Refund requested — ${refundAmountLine(details)}${reason ? ` (${reason})` : ""}`;
    }
    case "refund_succeeded":
      return `Refund completed — ${refundAmountLine(details)}`;
    case "refund_failed": {
      const msg = detailStr("message");
      return msg ? `Refund failed — ${msg}` : "Refund failed";
    }
    default:
      return event.type;
  }
}

// Shared amount rendering for refund events — details carry minor units
// (machine-usable) while the timeline shows the formatted amount.
function refundAmountLine(details: Record<string, unknown>): string {
  const minor =
    typeof details.amountMinor === "string"
      ? Number(details.amountMinor)
      : typeof details.amountMinor === "number"
        ? details.amountMinor
        : NaN;
  return Number.isFinite(minor) ? formatUsdMinor(minor) : "full amount";
}

// --- Creation input validation ---

export class PaymentError extends Error {
  // Annotated `boolean` so subclasses (e.g. PaymentProviderError) may
  // deliberately opt out of client-safe exposure.
  public readonly clientSafe: boolean = true;
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

// Provider failures are normalized into this shape before they cross the
// server boundary — only Stripe's machine-readable `code` is preserved.
// The raw error (message, request/response payloads) is never forwarded to
// the client, the audit trail, or structured log context.
//
// Deliberately NOT clientSafe: apiErrorResponse logs it through the
// normalized error path (safe name/message/code — observable in ops) and
// answers the generic fallback instead of a provider-flavored message.
export class PaymentProviderError extends PaymentError {
  public readonly clientSafe = false;
  // Carried on `code` so lib/log's normalizeError surfaces it as the safe
  // machine-level category (e.g. "rate_limit", "resource_missing").
  public readonly code: string;
  constructor(providerCode?: string | null) {
    super(
      "The payment provider could not complete the request. Please try again.",
      502
    );
    this.name = "PaymentProviderError";
    this.code = providerCode || "unexpected_provider_error";
  }
}

export function toPaymentProviderError(error: unknown): PaymentProviderError {
  if (error instanceof PaymentProviderError) return error;
  const code =
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
  return new PaymentProviderError(code);
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

// Idempotent-replay check: a clientRequestId may be retried only when the
// payment-relevant payload matches the stored record exactly. Any drift
// (amount, description, customer, tour details, note) means the submit was
// a *different* action reusing the id — a conflict, not a replay.
export function paymentCreateMatchesRecord(
  record: Record<string, unknown>,
  input: PaymentCreateInput
): boolean {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return (
    str(record.purpose) === input.purpose &&
    str(record.description) === input.description &&
    num(record.amountMinor) === input.amountMinor &&
    str(record.customerName) === input.customerName &&
    str(record.customerEmail) === input.customerEmail &&
    str(record.tourDate) === input.tourDate &&
    num(record.attendeeCount) === input.attendeeCount &&
    str(record.internalNote) === input.internalNote
  );
}

// --- Checkout Session construction ---

// Minimal structural shape of the Stripe SessionCreateParams we build —
// the server layer casts it onto the SDK type. Declared here (without the
// Stripe import) so the exact payload sent to Stripe is unit-testable.
export interface CheckoutSessionSpec {
  mode: "payment";
  client_reference_id: string;
  customer_email?: string;
  // Restricted to the card payment rail, intentionally: this is a
  // counter tool that must answer "paid now?" — delayed methods (bank
  // debits, BNPL) settle days later and would leave a charge looking
  // unpaid while the customer walks out. The card rail still surfaces
  // Stripe's accelerated card methods — Link, Apple Pay, Google Pay —
  // on eligible devices/accounts; those settle immediately like cards.
  // The async_payment_* webhook handlers stay wired defensively in
  // case account payment-method settings ever broaden this.
  payment_method_types: ["card"];
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
    receipt_email?: string;
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
    payment_method_types: ["card"],
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
      // Supplies the address Stripe emails receipts to — `customer_email`
      // alone only prefills the checkout form. Delivery itself is governed
      // by the Stripe account's email settings (and test mode never sends
      // email), so the stored hosted receipt URL stays the staff fallback.
      ...(args.customerEmail ? { receipt_email: args.customerEmail } : {}),
    },
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  };
}

// Hosted Checkout URLs are surfaced to staff (copy/QR) — only ever accept
// Stripe's own secure origin. Anything else (open redirect, lookalike
// domain, plain http) fails closed instead of reaching a customer's screen.
export const CHECKOUT_SESSION_URL_ORIGIN = "https://checkout.stripe.com";

export function assertCheckoutSessionUrl(url: unknown): string {
  let parsed: URL | null = null;
  if (typeof url === "string" && url) {
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
  }
  if (!parsed || parsed.origin !== CHECKOUT_SESSION_URL_ORIGIN) {
    throw new PaymentProviderError("invalid_checkout_url");
  }
  return url as string;
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
  // Canonical provider-reported money facts — read only from a re-fetched
  // Checkout Session (never the webhook payload) and compared against the
  // stored snapshot before a `paid` transition may apply.
  amountMinor?: number;
  currency?: string;
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

// The internal payment id embedded on a Checkout Session at creation.
// Read from the canonical retrieved object; absent on foreign sessions.
export function paymentIdFromSession(
  session: Record<string, unknown>
): string | null {
  const metadata = session.metadata;
  return (
    (metadata &&
    typeof metadata === "object" &&
    typeof (metadata as Record<string, unknown>).paymentId === "string"
      ? ((metadata as Record<string, unknown>).paymentId as string)
      : undefined) ??
    (typeof session.client_reference_id === "string"
      ? session.client_reference_id
      : undefined) ??
    null
  );
}

// Maps a checkout.session-shaped object to the internal outcome. Shared by
// the webhook (canonical retrieved session) and the refresh action so both
// reconcile identically.
export function outcomeFromSession(
  session: Record<string, unknown>,
  transition: StripeTransition,
  failureMessage?: string
): { paymentId: string | null; outcome: StripeOutcome } {
  const expiresAt =
    typeof session.expires_at === "number" && session.expires_at > 0
      ? session.expires_at * 1000
      : undefined;

  return {
    paymentId: paymentIdFromSession(session),
    outcome: {
      transition,
      sessionId: stripeIdOf(session.id) ?? (typeof session.id === "string" ? session.id : undefined),
      paymentIntentId: stripeIdOf(session.payment_intent),
      stripeCustomerId: stripeIdOf(session.customer),
      sessionExpiresAtMillis: expiresAt,
      failureMessage,
      amountMinor:
        typeof session.amount_total === "number"
          ? session.amount_total
          : undefined,
      currency:
        typeof session.currency === "string" ? session.currency : undefined,
    },
  };
}

// --- Webhook event references + canonical-state decisions ---

// The Checkout Session event types this app subscribes to. Everything else
// is acknowledged-and-ignored so stray subscriptions cannot corrupt state.
export const HANDLED_STRIPE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "checkout.session.expired",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
]);

export interface StripeEventRefs {
  eventId: string;
  eventType: string;
  sessionId: string | null;
}

// A signed webhook event proves Stripe sent it — it is NOT proof of the
// financial fields embedded in it. Only identifiers are extracted here;
// the session's status, payment_status, and amounts must come from the
// canonical re-fetched object (see app-foundations payment standard).
export function readStripeEventRefs(event: {
  id?: unknown;
  type?: unknown;
  data?: unknown;
}): StripeEventRefs {
  const object =
    event.data &&
    typeof event.data === "object" &&
    (event.data as { object?: unknown }).object &&
    typeof (event.data as { object?: unknown }).object === "object"
      ? ((event.data as { object: Record<string, unknown> })
          .object as Record<string, unknown>)
      : {};
  return {
    eventId: typeof event.id === "string" ? event.id : "",
    eventType: typeof event.type === "string" ? event.type : "",
    sessionId:
      object.object === "checkout.session"
        ? stripeIdOf(object.id) ?? null
        : null,
  };
}

export type CanonicalSessionDecision =
  | { kind: "transition"; transition: StripeTransition }
  | { kind: "ignored"; reason: string }
  | { kind: "retry" };

// Decides the internal transition from the *canonical* Checkout Session.
// The event type only disambiguates `complete`+`unpaid` (async failure vs.
// still-processing) — every financial fact is read from the session.
//
// `eventType` is null for the manual-refresh path, which has no delivery
// semantics: an open/unsettled session means "no change" rather than a
// retryable failure.
export function canonicalSessionDecision(
  eventType: string | null,
  session: Record<string, unknown>
): CanonicalSessionDecision {
  const status = typeof session.status === "string" ? session.status : "";
  const paymentStatus =
    typeof session.payment_status === "string" ? session.payment_status : "";

  if (status === "expired") {
    return { kind: "transition", transition: "expired" };
  }
  if (status === "complete") {
    if (paymentStatus === "paid" || paymentStatus === "no_payment_required") {
      return { kind: "transition", transition: "paid" };
    }
    if (paymentStatus === "unpaid") {
      if (eventType === "checkout.session.async_payment_failed") {
        return { kind: "transition", transition: "failed" };
      }
      if (eventType === "checkout.session.async_payment_succeeded") {
        // The event claims success but canonical state has not caught up —
        // ask Stripe to redeliver rather than settle (or fail) on a race.
        return { kind: "retry" };
      }
      return { kind: "transition", transition: "processing" };
    }
    return { kind: "ignored", reason: "unexpected_payment_status" };
  }
  if (status === "open") {
    // Session object has not settled for an event claiming a terminal
    // state — transient on webhook delivery, a no-op on manual refresh.
    return eventType === null
      ? { kind: "ignored", reason: "session_open" }
      : { kind: "retry" };
  }
  return { kind: "ignored", reason: "unexpected_session_state" };
}

// Resolves a verified webhook event + its canonical retrieved session into
// the outcome the event implies. Returns kind "retry" when canonical state
// has not settled — the delivery must be reattempted, not acknowledged.
export function resolveCanonicalEventOutcome(
  refs: StripeEventRefs,
  session: Record<string, unknown>
):
  | { kind: "resolved"; resolved: StripeEventOutcome }
  | { kind: "retry" } {
  const decision = canonicalSessionDecision(refs.eventType, session);
  const paymentId = paymentIdFromSession(session);

  if (decision.kind === "retry") {
    return { kind: "retry" };
  }
  if (decision.kind === "ignored") {
    return {
      kind: "resolved",
      resolved: {
        eventId: refs.eventId,
        eventType: refs.eventType,
        paymentId,
        ignoredReason: decision.reason,
      },
    };
  }
  const { outcome } = outcomeFromSession(session, decision.transition);
  if (!paymentId) {
    return {
      kind: "resolved",
      resolved: {
        eventId: refs.eventId,
        eventType: refs.eventType,
        paymentId: null,
        ignoredReason: "no_payment_reference",
      },
    };
  }
  return {
    kind: "resolved",
    resolved: {
      eventId: refs.eventId,
      eventType: refs.eventType,
      paymentId,
      outcome,
    },
  };
}

// --- Transition planning ---

export interface StripeApplyPlan {
  apply: boolean;
  updates: Record<string, unknown>;
  events: PaymentEventDraft[];
  // The status the plan would produce — for logging/response context.
  toStatus?: PaymentStatus;
  // Reconciliation code when settlement was refused — the payment keeps its
  // current status but is flagged for staff attention instead of marking
  // paid on contradicted provider evidence.
  quarantined?: string;
}

// Compares the canonical provider state embedded in an outcome against the
// immutable snapshot stored at initiation. Any disagreement — or money
// facts Stripe failed to report — means the settlement cannot be verified;
// returns the mismatch code and safe expected/actual strings for the audit
// event, or null when the outcome is consistent with the record.
export function reconcilePaymentSnapshot(
  record: PaymentRecord,
  outcome: StripeOutcome
): { code: string; expected: string; actual: string } | null {
  const storedSessionId =
    typeof record.stripeCheckoutSessionId === "string" &&
    record.stripeCheckoutSessionId
      ? record.stripeCheckoutSessionId
      : null;
  if (storedSessionId && outcome.sessionId !== storedSessionId) {
    return {
      code: "session_mismatch",
      expected: storedSessionId,
      actual: outcome.sessionId ?? "missing",
    };
  }
  const storedCurrency =
    typeof record.currency === "string" && record.currency
      ? record.currency
      : PAYMENT_CURRENCY;
  if (
    typeof outcome.currency !== "string" ||
    outcome.currency.toUpperCase() !== storedCurrency.toUpperCase()
  ) {
    return {
      code: "currency_mismatch",
      expected: storedCurrency.toUpperCase(),
      actual: outcome.currency ?? "missing",
    };
  }
  if (
    typeof outcome.amountMinor !== "number" ||
    outcome.amountMinor !== record.amountMinor
  ) {
    return {
      code: "amount_mismatch",
      expected: String(record.amountMinor ?? "missing"),
      actual: String(outcome.amountMinor ?? "missing"),
    };
  }
  return null;
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
    // `failed` is not a source for `processing`: an async payment that
    // failed left its Checkout Session complete+unpaid and cannot be
    // retried — a failed record must never regress to pending.
    processing: new Set<PaymentStatus>(["created", "awaiting_payment"]),
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

  // Money may be marked settled only when canonical provider state matches
  // the snapshot taken at initiation. A mismatch is quarantined — flagged
  // for attention, never silently paid and never auto-corrected.
  if (target === "paid") {
    const mismatch = reconcilePaymentSnapshot(record, outcome);
    if (mismatch) {
      if (record.reconciliationIssue === mismatch.code) {
        // Same mismatch already recorded — stay quarantined without
        // appending duplicate audit events.
        return {
          apply: false,
          updates: {},
          events: [],
          toStatus: current,
          quarantined: mismatch.code,
        };
      }
      return {
        apply: true,
        updates: {
          reconciliationIssue: mismatch.code,
          updatedAt: now,
        },
        events: [
          {
            type: "reconciliation_mismatch",
            details: {
              ...sourceDetail,
              reason: mismatch.code,
              expected: mismatch.expected,
              actual: mismatch.actual,
            },
          },
        ],
        toStatus: current,
        quarantined: mismatch.code,
      };
    }
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
      // A cleanly reconciled settlement clears a prior flag (e.g. canonical
      // state corrected itself after an early delivery raced).
      updates.reconciliationIssue = null;
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
    result: "applied" | "ignored" | "unknown_payment" | "mismatch",
    meta: { eventType: string; paymentId: string | null }
  ): Promise<void>;
}

export interface StripeEventStore {
  transact<R>(work: (tx: StripeEventTx) => Promise<R>): Promise<R>;
}

export interface StripeEventResult {
  status:
    | "applied"
    | "duplicate"
    | "ignored"
    | "unknown_payment"
    | "quarantined";
  paymentId: string | null;
  toStatus?: PaymentStatus;
  quarantined?: string;
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
      plan.quarantined ? "mismatch" : plan.apply ? "applied" : "ignored",
      meta
    );
    return {
      status: plan.quarantined
        ? "quarantined"
        : plan.apply
          ? "applied"
          : "ignored",
      paymentId: resolved.paymentId,
      toStatus: plan.toStatus,
      quarantined: plan.quarantined,
    };
  });
}

// --- Refunds (full refunds only, 1-hour in-app window) ---

// The in-app refund window after `paidAt`. Deliberately short: this tool
// covers "the customer is still standing here" corrections; anything
// later is a considered decision that belongs in the Stripe Dashboard.
// Strict boundary — exactly REFUND_WINDOW_MS elapsed means the window has
// passed (59:59.999 in, 1:00:00 out).
export const REFUND_WINDOW_MS = 60 * 60 * 1000;

// The exact phrase staff must type before the destructive action enables.
export const REFUND_CONFIRMATION_PHRASE = "REFUND";
export const REFUND_REASON_MAX_LENGTH = 500;

// Deterministic Stripe idempotency key, scoped to one refund attempt —
// the attempt counter persisted by the durable claim. Replays of the same
// attempt reuse the key (Stripe replays its saved result, so a lost
// response can never mint a second refund), while a fresh claim after a
// confirmed failure gets a new key and can genuinely retry — a saved
// *error* under an old key must not doom every later attempt.
export function refundIdempotencyKey(paymentId: string, attempt: number): string {
  return `refund:${paymentId}:${attempt}`;
}

// Millis for Firestore-shaped timestamp values (Timestamp-like, Date,
// epoch number, ISO string). Returns null when absent/unparseable so
// callers fail closed instead of treating "no timestamp" as epoch 0.
export function timestampMillis(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (
    typeof value === "object" &&
    "toMillis" in value &&
    typeof (value as { toMillis: unknown }).toMillis === "function"
  ) {
    const t = (value as { toMillis: () => number }).toMillis();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number" || typeof value === "string") {
    const t = new Date(value).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export type RefundDenyCode =
  | "not_paid"
  | "refund_in_progress"
  | "already_refunded"
  | "missing_paid_at"
  | "missing_stripe_reference"
  | "window_expired";

export type RefundEligibility =
  | { ok: true }
  | { ok: false; code: RefundDenyCode; message: string };

// The single eligibility rule, enforced server-side and mirrored as an
// advisory check in the UI. All inputs are already-resolved facts so the
// same function serves the Firestore record and the serialized view.
export function paymentRefundEligibility(args: {
  status: unknown;
  paidAtMillis: number | null;
  hasStripePaymentRef: boolean;
  nowMillis: number;
}): RefundEligibility {
  const status = normalizePaymentStatus(args.status);
  if (status === "refunded") {
    return {
      ok: false,
      code: "already_refunded",
      message: "This payment has already been refunded.",
    };
  }
  if (status === "refunding") {
    return {
      ok: false,
      code: "refund_in_progress",
      message: "A refund is already in progress for this payment.",
    };
  }
  if (status !== "paid") {
    return {
      ok: false,
      code: "not_paid",
      message: "Only a paid payment can be refunded.",
    };
  }
  if (args.paidAtMillis === null) {
    return {
      ok: false,
      code: "missing_paid_at",
      message:
        "This payment has no recorded paid time — refund it in the Stripe Dashboard.",
    };
  }
  if (!args.hasStripePaymentRef) {
    return {
      ok: false,
      code: "missing_stripe_reference",
      message:
        "This payment has no Stripe payment reference — refund it in the Stripe Dashboard.",
    };
  }
  if (args.nowMillis - args.paidAtMillis >= REFUND_WINDOW_MS) {
    return {
      ok: false,
      code: "window_expired",
      message:
        "Refunds can be issued here for 1 hour after payment. After that, use Stripe Dashboard.",
    };
  }
  return { ok: true };
}

export interface RefundRequestInput {
  reason: string;
}

// The browser supplies intent only — a reason and the typed confirmation.
// The refund amount is always derived from the stored payment, never from
// the request.
export function parseRefundBody(
  body: unknown
): { ok: true; input: RefundRequestInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request body." };
  }
  const raw = body as Record<string, unknown>;
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (!reason) {
    return { ok: false, error: "A refund reason is required." };
  }
  if (reason.length > REFUND_REASON_MAX_LENGTH) {
    return { ok: false, error: "Refund reason is too long." };
  }
  if (raw.confirmation !== REFUND_CONFIRMATION_PHRASE) {
    return {
      ok: false,
      error: `Type ${REFUND_CONFIRMATION_PHRASE} to confirm the refund.`,
    };
  }
  return { ok: true, input: { reason } };
}

export type RefundClaimPlan =
  | { kind: "already_refunded" }
  | { kind: "resume" }
  | {
      kind: "claim";
      updates: Record<string, unknown>;
      event: PaymentEventDraft;
    }
  | { kind: "reject"; code: RefundDenyCode; message: string };

// Pure claim planner applied inside the claim transaction: `claim` writes
// the durable refunding state + audit event, `resume` means an earlier
// request already claimed the refund (the caller continues from canonical
// Stripe state without a second claim), and `already_refunded` makes a
// replayed request a safe no-op.
export function planRefundClaim(
  record: PaymentRecord,
  reason: string,
  nowMillis: number
): RefundClaimPlan {
  const status = normalizePaymentStatus(record.status);
  // Terminal/in-flight refund states resolve without re-checking the
  // window: a replayed request on a refunded record is a safe no-op, and
  // an in-flight claim is resumed from canonical Stripe state.
  if (status === "refunded") return { kind: "already_refunded" };
  if (status === "refunding") return { kind: "resume" };

  const eligibility = paymentRefundEligibility({
    status: record.status,
    paidAtMillis: timestampMillis(record.paidAt),
    hasStripePaymentRef:
      typeof record.stripePaymentIntentId === "string" &&
      record.stripePaymentIntentId.length > 0,
    nowMillis,
  });
  if (!eligibility.ok) {
    return {
      kind: "reject",
      code: eligibility.code,
      message: eligibility.message,
    };
  }
  return {
    kind: "claim",
    updates: {
      status: "refunding",
      refundReason: reason,
      refundFailureMessage: null,
      // Attempt counter scoped by the claim — drives the Stripe
      // idempotency key. A `resume` keeps the claimed attempt (same key,
      // same refund); a fresh claim after a released failure increments
      // it (new key, new refund object allowed).
      refundAttempt:
        (typeof record.refundAttempt === "number" ? record.refundAttempt : 0) +
        1,
    },
    event: {
      type: "refund_requested",
      details: {
        amountMinor:
          typeof record.amountMinor === "number"
            ? String(record.amountMinor)
            : null,
        reason,
      },
    },
  };
}

export type RefundCanonicalDecision =
  | { kind: "create_refund" }
  | {
      kind: "already_refunded";
      stripeRefundId?: string;
      refundAmountMinor?: number;
    }
  | { kind: "reject"; code: string; message: string };

// True when the charge carries a refund that has not reached a final
// state — `pending` or `requires_action` per the Refund lifecycle.
function chargeHasPendingRefund(charge: Record<string, unknown>): boolean {
  const refunds = charge.refunds;
  if (!refunds || typeof refunds !== "object") return false;
  const data = (refunds as Record<string, unknown>).data;
  if (!Array.isArray(data)) return false;
  return data.some((entry) => {
    const status =
      entry && typeof entry === "object"
        ? (entry as Record<string, unknown>).status
        : undefined;
    return status === "pending" || status === "requires_action";
  });
}

function firstRefundId(charge: Record<string, unknown>): string | undefined {
  const refunds = charge.refunds;
  if (refunds && typeof refunds === "object") {
    const data = (refunds as Record<string, unknown>).data;
    if (Array.isArray(data)) {
      for (const entry of data) {
        const id = stripeIdOf(entry);
        if (id) return id;
      }
    }
  }
  return undefined;
}

// Verifies a re-fetched PaymentIntent against the stored record before a
// refund may be created. Canonical Stripe state decides: reference,
// amount, currency, and settlement must all agree, and a charge Stripe
// already reports refunded is converged to (never a second refund).
export function decideRefundFromPaymentIntent(
  paymentId: string,
  record: PaymentRecord,
  intent: Record<string, unknown>
): RefundCanonicalDecision {
  const storedIntentId =
    typeof record.stripePaymentIntentId === "string"
      ? record.stripePaymentIntentId
      : "";
  if (!storedIntentId || stripeIdOf(intent.id) !== storedIntentId) {
    return {
      kind: "reject",
      code: "intent_mismatch",
      message: "Stripe's payment record does not match this payment.",
    };
  }
  const metadata = intent.metadata;
  const metaPaymentId =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).paymentId
      : undefined;
  if (metaPaymentId !== undefined && metaPaymentId !== paymentId) {
    return {
      kind: "reject",
      code: "payment_mismatch",
      message: "Stripe's payment record belongs to a different payment.",
    };
  }
  const storedCurrency =
    typeof record.currency === "string" && record.currency
      ? record.currency
      : PAYMENT_CURRENCY;
  if (
    typeof intent.currency !== "string" ||
    intent.currency.toUpperCase() !== storedCurrency.toUpperCase()
  ) {
    return {
      kind: "reject",
      code: "currency_mismatch",
      message: "Stripe reports a different currency for this charge.",
    };
  }
  if (
    typeof record.amountMinor !== "number" ||
    typeof intent.amount !== "number" ||
    intent.amount !== record.amountMinor
  ) {
    return {
      kind: "reject",
      code: "amount_mismatch",
      message: "Stripe reports a different amount for this charge.",
    };
  }
  if (intent.status !== "succeeded") {
    return {
      kind: "reject",
      code: "not_settled",
      message: "Stripe does not show this payment as completed.",
    };
  }
  const charge = intent.latest_charge;
  if (!charge || typeof charge !== "object") {
    return {
      kind: "reject",
      code: "no_charge",
      message: "Stripe shows no captured charge for this payment.",
    };
  }
  const refundedMinor =
    typeof (charge as Record<string, unknown>).amount_refunded === "number"
      ? ((charge as Record<string, unknown>).amount_refunded as number)
      : 0;
  if (refundedMinor >= record.amountMinor) {
    // The money is already back with the customer — a Dashboard refund or
    // a provider retry of our own earlier call. Converge, never re-create.
    return {
      kind: "already_refunded",
      stripeRefundId: firstRefundId(charge as Record<string, unknown>),
      refundAmountMinor: refundedMinor,
    };
  }
  // A refund still in flight (card refunds are asynchronous: `pending`
  // can later succeed or fail) must settle before anything else runs —
  // creating another refund object now could double-refund once it lands.
  if (chargeHasPendingRefund(charge as Record<string, unknown>)) {
    return {
      kind: "reject",
      code: "refund_pending",
      message:
        "A refund is already processing in Stripe — check the Stripe Dashboard before retrying.",
    };
  }
  if (refundedMinor > 0) {
    return {
      kind: "reject",
      code: "partial_refund_exists",
      message:
        "A partial refund already exists in Stripe — finish it in the Stripe Dashboard.",
    };
  }
  return { kind: "create_refund" };
}

// Safe refund facts persisted on the record — ids, amount, status only.
// Never a raw Stripe refund object.
export function refundFactsFromStripeRefund(
  refund: Record<string, unknown>
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  const id = stripeIdOf(refund.id);
  if (id) updates.stripeRefundId = id;
  if (typeof refund.amount === "number") {
    updates.refundAmountMinor = refund.amount;
  }
  if (typeof refund.currency === "string" && refund.currency) {
    updates.refundCurrency = refund.currency;
  }
  if (typeof refund.status === "string" && refund.status) {
    updates.stripeRefundStatus = refund.status;
  }
  return updates;
}

// "Collected today" counts money still held: a payment paid today whose
// refund has not completed. A `refunding` payment still counts (the money
// may yet stay if the refund fails); a `refunded` one drops out — the
// day's net position for it is zero.
export function isCollectedForDailyTotal(args: {
  status: unknown;
  paidAtMillis: number | null;
  dayStartMillis: number;
}): boolean {
  const status = normalizePaymentStatus(args.status);
  return (
    (status === "paid" || status === "refunding") &&
    args.paidAtMillis !== null &&
    args.paidAtMillis >= args.dayStartMillis
  );
}
