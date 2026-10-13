// Shared, dependency-free vocabulary for the QuickBooks Online (QBO)
// integration (issue #161). Firebase-free so admin client components may
// import the view/label types; all persistence and provider IO lives in the
// server-only modules (lib/qbo.ts, lib/qbo-api.ts, lib/qbo-webhook.ts,
// lib/qbo-sync.ts).

// --- Environment ---

export type QboEnvironment = "sandbox" | "production";

export const QBO_ENVIRONMENTS: readonly QboEnvironment[] = [
  "sandbox",
  "production",
];

export function isQboEnvironment(value: unknown): value is QboEnvironment {
  return value === "sandbox" || value === "production";
}

export function qboEnvironmentLabel(environment: QboEnvironment): string {
  return environment === "production" ? "Production" : "Sandbox";
}

// --- Collection names (all deny-all to Firebase clients — firestore.rules) ---

export const QBO_CONNECTIONS_COLLECTION = "qboConnections";
export const QBO_OAUTH_STATES_COLLECTION = "qboOauthStates";
export const QBO_WEBHOOK_RECEIPTS_COLLECTION = "qboWebhookReceipts";
export const QBO_CONFIG_COLLECTION = "qboConfig";
export const QBO_SYNC_RECORDS_COLLECTION = "qboSyncRecords";
export const QBO_SWEEP_STATE_COLLECTION = "qboSweepState";

export const QBO_ACCOUNTING_MAPPING_DOC = "accountingMapping";

// --- Connection state ---

// `not_configured` — the deployment lacks the required QBO_* env vars.
// `disconnected` — configured but no live connection record.
// `connected` — a usable connection exists.
// `reauthorization_required` — Intuit revoked or rejected the stored grant;
// an admin must run the OAuth flow again.
export type QboConnectionStatus =
  | "not_configured"
  | "disconnected"
  | "connected"
  | "reauthorization_required";

// Health is the last observed outcome of an authenticated API probe, not a
// recomputed promise — the admin UI shows it as "last check" information.
export type QboHealthStatus =
  | "unknown"
  | "healthy"
  | "needs_reauthorization"
  | "provider_unavailable";

// Serialized admin-facing connection view. The server must never include
// access/refresh tokens or any credential material in this shape.
export interface QboAdminView {
  configured: boolean;
  environment: QboEnvironment;
  environmentLabel: string;
  status: QboConnectionStatus;
  health: QboHealthStatus;
  realmIdShort?: string;
  companyName?: string;
  companyCountry?: string;
  connectedAt?: string;
  connectedByEmail?: string;
  lastCheckAt?: string;
  mappingConfigured: boolean;
}

// realmId is an opaque Intuit identifier; show only a short form so an
// admin can confirm "which company" without the full value traveling to the
// browser.
export function abbreviateRealmId(realmId: string): string {
  const clean = realmId.trim();
  if (clean.length <= 8) return clean;
  return `${clean.slice(0, 4)}…${clean.slice(-4)}`;
}

// --- Accounting discovery entities ---

// Read-only entity types queried for the future mapping surface. The keys
// are also the `type` query-parameter values accepted by the entities
// route — keep the vocabulary small and explicit.
export const QBO_DISCOVERY_ENTITY_TYPES = [
  "account",
  "item",
  "customer",
  "payment-method",
  "tax-code",
] as const;

export type QboDiscoveryEntityType =
  (typeof QBO_DISCOVERY_ENTITY_TYPES)[number];

export function isQboDiscoveryEntityType(
  value: unknown
): value is QboDiscoveryEntityType {
  return (
    typeof value === "string" &&
    (QBO_DISCOVERY_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

// Canonical safe shape for a QBO entity shown to admins. Raw QBO records
// never cross the provider boundary.
export interface QboEntitySummary {
  id: string;
  name: string;
  /** e.g. AccountType ("Income", "Bank") or Item Type ("Service"). */
  type?: string;
  /** e.g. AccountSubType when it disambiguates the pick. */
  detail?: string;
  active: boolean;
}

// --- Accounting mapping configuration ---

// Where Stripe-settled DDB payment revenue posts in QBO (the Sales
// Receipt model, design §5/§11). Every value is a QBO entity Id
// discovered from the *connected* company — never hard-coded.
export interface QboAccountingMapping {
  /** Account gross sales receipts deposit into until Stripe payouts
   *  reconcile (the "Stripe clearing account", e.g. `Stripe Balance`). */
  stripeClearingAccountId?: string;
  /** Account cash sales receipts deposit into (e.g. `Cash on hand` /
   *  `Undeposited Funds`). Optional at the mapping level — required only
   *  before a cash payment can post; never the Stripe clearing account. */
  cashDepositAccountId?: string;
  /** QBO PaymentMethod recorded on card/Stripe sales receipts (e.g.
   *  `Credit Card` or `Stripe`, whichever the company carries). Required
   *  like the other universal fields — every card receipt populates it. */
  cardPaymentMethodId?: string;
  /** QBO PaymentMethod recorded on cash sales receipts (expected choice:
   *  the company's `Cash` method). Optional at the mapping level —
   *  required only before a cash payment can post. */
  cashPaymentMethodId?: string;
  /** Item used for brewery-tour income lines. */
  tourIncomeItemId?: string;
  /** Item used for tasting/flight income lines. */
  tastingIncomeItemId?: string;
  /** Item used for other ad-hoc income lines. */
  otherIncomeItemId?: string;
  /** Customer recorded on every sales receipt — the "generic sales
   *  customer". The persisted key predates the finalized model and is
   *  kept for compatibility; it is the normal customer for this posting
   *  model, not a fallback. */
  fallbackCustomerId?: string;
  /** Optional tax code when the company's tax setup requires one. */
  taxCodeId?: string;
  /** Price/tax treatment the accountant verified — required before a
   *  mapped `taxCodeId` may post on a non-US receipt (it drives QBO's
   *  `GlobalTaxCalculation`). `"inclusive"` = the charged price already
   *  contains the tax; `"exclusive"` = tax is added on top of the
   *  posted amount. Meaningless without a tax code: the save path
   *  rejects either half of the pair on its own, and the worker fails
   *  closed if a stored document ever violates the pairing. */
  taxCalculation?: QboTaxCalculation;
  /** Expense account Stripe processing fees post to (e.g. merchant /
   *  credit-card fees). Optional — fee posting stays dormant until the
   *  accountant confirms a mapped expense account and the enqueue
   *  producer is wired on (issue #181 design §9). */
  stripeFeeExpenseAccountId?: string;
  /** Destination for the payout-transfer proposal's debit leg — the
   *  bank account Stripe settles into, or a "Payouts in Transit"
   *  clearing account when the accountant prefers to match the bank
   *  feed explicitly. Optional — payout transfers stay blocked until
   *  it is selected (payout accounting automation). */
  stripePayoutAccountId?: string;
}

// How the company's charged prices relate to the tax a mapped TaxCode
// computes (issue #184). This is a business answer, not a derivable
// fact — only the accountant can supply it. The values are the app's
// own vocabulary; the protocol layer translates them to QBO's
// `GlobalTaxCalculation` enum at the provider boundary.
export const QBO_TAX_CALCULATIONS = ["inclusive", "exclusive"] as const;

export type QboTaxCalculation = (typeof QBO_TAX_CALCULATIONS)[number];

export function isQboTaxCalculation(
  value: unknown
): value is QboTaxCalculation {
  return (
    typeof value === "string" &&
    (QBO_TAX_CALCULATIONS as readonly string[]).includes(value)
  );
}

// The finalized field set for the Sales-Receipt posting model (issue
// #182, design §11). Shared between the server-side save/validation path
// (lib/qbo-mapping.ts) and the admin UI so the required list can never
// drift between the two. `label` is the operator-facing name shown in
// the admin surface and used in validation errors.
// The mapping keys that select a live QBO entity — the only keys
// QBO_MAPPING_FIELDS may carry. `taxCalculation` is a stored policy
// value, not an entity reference, so it lives outside this union.
export type QboEntityMappingKey = Exclude<
  keyof QboAccountingMapping,
  "taxCalculation"
>;

export interface QboMappingFieldSpec {
  key: QboEntityMappingKey;
  /** Discovery entity type the selection is validated against. */
  entityType: QboDiscoveryEntityType;
  label: string;
  /** The posting model cannot run without a required field selected. */
  required: boolean;
}

export const QBO_MAPPING_FIELDS: readonly QboMappingFieldSpec[] = [
  {
    key: "stripeClearingAccountId",
    entityType: "account",
    label: "Stripe clearing account",
    required: true,
  },
  {
    // Not a completeness requirement — card payments post without it.
    // A cash payment with no cash account mapped fails closed into
    // needs_attention rather than guessing a destination (issue #206).
    key: "cashDepositAccountId",
    entityType: "account",
    label: "Cash deposit account",
    required: false,
  },
  {
    // The receipt's PaymentMethodRef must name a real PaymentMethod in
    // the connected company — card naming varies by company (Credit
    // Card / Stripe / other), so it is resolved explicitly here, never
    // assumed (issue #206 follow-up).
    key: "cardPaymentMethodId",
    entityType: "payment-method",
    label: "Card payment method",
    required: true,
  },
  {
    // Same rail-optional rule as the cash deposit account: card posting
    // does not need it, but a cash payment without it fails closed into
    // needs_attention (issue #206 follow-up).
    key: "cashPaymentMethodId",
    entityType: "payment-method",
    label: "Cash payment method",
    required: false,
  },
  {
    key: "tourIncomeItemId",
    entityType: "item",
    label: "Tour income item",
    required: true,
  },
  {
    key: "tastingIncomeItemId",
    entityType: "item",
    label: "Tasting income item",
    required: true,
  },
  {
    key: "otherIncomeItemId",
    entityType: "item",
    label: "Other income item",
    required: true,
  },
  {
    key: "fallbackCustomerId",
    entityType: "customer",
    label: "Generic sales customer",
    required: true,
  },
  {
    key: "taxCodeId",
    entityType: "tax-code",
    label: "Tax code",
    required: false,
  },
  {
    key: "stripeFeeExpenseAccountId",
    entityType: "account",
    label: "Stripe fee expense account",
    required: false,
  },
  {
    // Payout-transfer destination: the bank account Stripe settles into,
    // or a "Payouts in Transit" account when the accountant prefers to
    // clear against the bank feed — the mapping decides which (payout
    // accounting automation). Optional — payout transfers are proposed
    // as blocked until it is selected.
    key: "stripePayoutAccountId",
    entityType: "account",
    label: "Stripe payout account",
    required: false,
  },
];

// Required fields still unset on a (partial) mapping — empty means the
// mapping is complete enough for the posting model to run.
export function qboMissingMappingFields(
  mapping: Partial<QboAccountingMapping> | null | undefined
): (keyof QboAccountingMapping)[] {
  return QBO_MAPPING_FIELDS.filter(
    (field) => field.required && !mapping?.[field.key]
  ).map((field) => field.key);
}

export interface QboAccountingMappingView {
  configured: boolean;
  mapping?: QboAccountingMapping;
  /** Required fields still unset — present when `configured`; an empty
   *  array means the mapping is complete. A stored document can only be
   *  incomplete if it predates the required-field enforcement. */
  missingFields?: (keyof QboAccountingMapping)[];
  /** Display names resolved at save/read time when known. */
  entityNames?: Record<string, string>;
  updatedAt?: string;
}

// --- Future accounting sync contract (issue #161 boundary for #156) ---

// The domain facts a future producer (e.g. the Stripe payments module)
// supplies. The QBO side owns how these map onto accounting entities; the
// producer must not decide bookkeeping representation.
export interface QuickBooksSyncCandidate {
  /** Stable source vocabulary, e.g. "stripe_payment". */
  sourceType: string;
  /** The producer's durable internal id for the financial event. */
  sourceId: string;
  amountMinorUnits: number;
  /** Uppercase ISO-4217 code. */
  currency: string;
  /** ISO date or datetime of the financial event. */
  transactionDate: string;
  customerName?: string;
  customerEmail?: string;
  /** e.g. "brewery_tour", "tasting", "ad_hoc". */
  purpose?: string;
  description?: string;
  /** Opaque provider references (PaymentIntent/Charge/receipt ids). */
  externalRefs?: Record<string, string>;
  tourDate?: string;
  attendeeCount?: number;
}

export type QboSyncStatus =
  | "pending"
  | "syncing"
  | "synced"
  | "failed"
  | "needs_attention";

export const QBO_SYNC_STATUSES: readonly QboSyncStatus[] = [
  "pending",
  "syncing",
  "synced",
  "failed",
  "needs_attention",
];

export function isQboSyncStatus(value: unknown): value is QboSyncStatus {
  return (
    typeof value === "string" &&
    (QBO_SYNC_STATUSES as readonly string[]).includes(value)
  );
}

// --- Sync operations admin surface (issue #183) ---

// Serialized per-record view for the admin sync panel. Deliberately narrow:
// no candidate payload (customer PII), no tokens, no provider payloads —
// only safe operational state.
export interface QboSyncRecordView {
  syncId: string;
  sourceType: string;
  sourceId: string;
  status: QboSyncStatus;
  attempts: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  qboEntityType?: string;
  qboEntityId?: string;
  realmIdShort?: string;
  updatedAt?: string;
}

export type QboSyncStatusCounts = Record<QboSyncStatus, number>;

export interface QboSyncAdminView {
  configured: boolean;
  environment: QboEnvironment;
  /** True while the connection cannot write (disconnected or
   *  reauthorization_required) — records accumulate, nothing posts. */
  paused: boolean;
  counts: QboSyncStatusCounts;
  /** Recent `failed`/`needs_attention` records, newest activity first. */
  records: QboSyncRecordView[];
  /** True when the problem-record scan hit its cap — there may be more
   *  failed/needs_attention records than the panel lists. */
  truncated: boolean;
}

// Coarse outcome codes the manual-retry admin route returns.
export type QboSyncRetryOutcome =
  | "synced"
  | "already_synced"
  | "queued"
  | "in_progress"
  | "paused"
  | "deferred"
  | "needs_attention"
  | "failed"
  | "missing";

// Deterministic internal sync-record key. The internal source identity is
// the idempotency anchor — a future QBO entity id is correlation only, so
// retries, webhook replays, and browser refreshes can never create two QBO
// transactions for the same source event. The environment is part of the
// identity: the same Firestore database may host a sandbox connection now
// and a production one later, and each must get its own record.
export function qboSyncIdFor(
  environment: QboEnvironment,
  sourceType: string,
  sourceId: string
): string {
  const type = sourceType.trim();
  const id = sourceId.trim();
  if (!type || !id) {
    throw new Error("qboSyncIdFor requires a non-empty sourceType and sourceId.");
  }
  return `${environment}:${type}:${id}`;
}

const SYNC_SOURCE_TYPE_PATTERN = /^[a-z0-9_]{1,40}$/;
const SYNC_CURRENCY_PATTERN = /^[A-Z]{3}$/;

// Validates and normalizes a producer-supplied sync candidate. Throws a
// plain Error on malformed input — the caller (server route or internal
// producer) treats it as a validation failure.
export function normalizeQboSyncCandidate(
  input: QuickBooksSyncCandidate
): QuickBooksSyncCandidate {
  if (typeof input !== "object" || input === null) {
    throw new Error("Sync candidate must be an object.");
  }
  const sourceType = (input.sourceType ?? "").trim();
  if (!SYNC_SOURCE_TYPE_PATTERN.test(sourceType)) {
    throw new Error("Sync candidate sourceType is invalid.");
  }
  const sourceId = (input.sourceId ?? "").trim();
  if (!sourceId || sourceId.length > 128) {
    throw new Error("Sync candidate sourceId is missing or too long.");
  }
  if (!Number.isInteger(input.amountMinorUnits)) {
    throw new Error("Sync candidate amountMinorUnits must be an integer.");
  }
  const currency = (input.currency ?? "").trim().toUpperCase();
  if (!SYNC_CURRENCY_PATTERN.test(currency)) {
    throw new Error("Sync candidate currency must be a 3-letter ISO code.");
  }
  const transactionDate = (input.transactionDate ?? "").trim();
  if (!transactionDate || Number.isNaN(new Date(transactionDate).getTime())) {
    throw new Error("Sync candidate transactionDate is invalid.");
  }

  const externalRefs: Record<string, string> = {};
  if (input.externalRefs) {
    for (const [key, value] of Object.entries(input.externalRefs)) {
      if (Object.keys(externalRefs).length >= 20) break;
      if (typeof value !== "string" || !value || value.length > 128) {
        continue;
      }
      externalRefs[key.trim().slice(0, 64)] = value;
    }
  }

  const optionalString = (value: unknown, max: number): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

  return {
    sourceType,
    sourceId,
    amountMinorUnits: input.amountMinorUnits,
    currency,
    transactionDate,
    customerName: optionalString(input.customerName, 200),
    customerEmail: optionalString(input.customerEmail, 254),
    purpose: optionalString(input.purpose, 60),
    description: optionalString(input.description, 500),
    externalRefs: Object.keys(externalRefs).length ? externalRefs : undefined,
    tourDate: optionalString(input.tourDate, 40),
    attendeeCount:
      Number.isInteger(input.attendeeCount) && (input.attendeeCount ?? 0) > 0
        ? input.attendeeCount
        : undefined,
  };
}

// Firestore rejects `undefined` property values at write time, and the
// normalizer deliberately emits `undefined` for absent optional fields.
// Strip them before the candidate is persisted inside the sync record.
// Nested values are already concrete (`externalRefs` only ever holds
// validated strings), so a shallow pass is sufficient.
export function persistableQboSyncCandidate(
  candidate: QuickBooksSyncCandidate
): QuickBooksSyncCandidate {
  return Object.fromEntries(
    Object.entries(candidate).filter(([, value]) => value !== undefined)
  ) as QuickBooksSyncCandidate;
}

// --- Sales Receipt write model (issue #179) ---

// The only source types the sync worker posts — a settled payment from
// the app's own `payments` collection, one per payment rail (issue #206).
// Positive identity is structural: only records the tool itself issued
// can carry these types, and the worker re-verifies that the sync
// record's source type matches the canonical payment's own rail.
export const QBO_STRIPE_PAYMENT_SOURCE_TYPE = "stripe_payment";
export const QBO_CASH_PAYMENT_SOURCE_TYPE = "cash_payment";
export const QBO_SALES_RECEIPT_ENTITY_TYPE = "SalesReceipt";

// Stripe processing-fee posting (issue #181). Deliberately dormant: the
// source-type vocabulary exists so a future worker arm can enqueue
// `stripe_fee` records with durable Stripe-transaction identity, but no
// producer or worker path is wired — activation is a deliberate follow-up
// once ownership and duplicate-prevention are verified with the
// accountant (design §9).
export const QBO_STRIPE_FEE_SOURCE_TYPE = "stripe_fee";
export const QBO_PURCHASE_ENTITY_TYPE = "Purchase";

// Maps a payment-tool `purpose` onto the income-item mapping field, per
// the accounting design doc. This is the QBO side's bookkeeping decision
// — the producer only supplies the purpose string. An unrecognized
// purpose returns null so the worker fails closed instead of posting to
// an arbitrary item.
export function qboIncomeItemKeyForPurpose(
  purpose: string | undefined
): keyof QboAccountingMapping | null {
  switch (purpose) {
    // Tour-family purposes post to tour income — `additional_guests` and
    // `private_tour` are tour volume, per the design doc.
    case "brewery_tour":
    case "additional_guests":
    case "private_tour":
      return "tourIncomeItemId";
    case "brewery_tour_tasting":
      return "tastingIncomeItemId";
    case "other":
      return "otherIncomeItemId";
    default:
      return null;
  }
}

// Human-auditable correlation marker embedded in the Sales Receipt's
// PrivateNote. Provider-side recovery (design §12 — a write that landed
// but whose response was lost) matches on this token, so a retried sync
// adopts the existing receipt instead of posting a duplicate.
export function qboSalesReceiptMarker(sourceId: string): string {
  return `ddb:${sourceId}`;
}

// QBO DocNumber is limited to 21 characters. Deriving a stable, readable
// number from the source id gives QBO users a searchable back-reference
// and a second dedupe handle where custom transaction numbers are on.
export function qboSalesReceiptDocNumber(sourceId: string): string {
  const clean = sourceId.replace(/[^A-Za-z0-9]/g, "");
  return `DDB-${clean.slice(-17)}`.slice(0, 21);
}

// Correlation marker for the Stripe fee Purchase (issue #181) — distinct
// from the receipt marker so a clearing-account scan can tell the sale and
// its fee apart. Same adoption rule: a landed-but-unconfirmed Purchase is
// found by this marker instead of re-posted.
export function qboFeePurchaseMarker(sourceId: string): string {
  return `ddb-fee:${sourceId}`;
}

// Purchase DocNumber counterpart to the receipt's `DDB-…` numbering.
export function qboPurchaseDocNumber(sourceId: string): string {
  const clean = sourceId.replace(/[^A-Za-z0-9]/g, "");
  return `DDBF-${clean.slice(-16)}`.slice(0, 21);
}

// --- Tax policy resolution (issue #184) ---

// The tax fields one sales-side transaction carries (SalesReceipt today;
// the RefundReceipt in #180 mirrors the same resolution). Derived purely
// from the accounting mapping and the connected company's country —
// never from a guessed rate or a TaxCode name.
export type QboTaxSpec =
  | {
      ok: true;
      /** Present only when a verified TaxCode was explicitly mapped —
       *  the activation switch for tax posting. */
      taxCodeId?: string;
      /** `GlobalTaxCalculation` value for the payload: `NotApplicable`
       *  for a non-US company with no tax code, `TaxInclusive` /
       *  `TaxExcluded` per the verified price treatment when a code is
       *  mapped, absent for US companies (which reject the field). */
      globalTaxCalculation?: "NotApplicable" | "TaxInclusive" | "TaxExcluded";
    }
  | {
      ok: false;
      /** The stored mapping holds half of the tax pair — a code with
       *  a missing or unrecognized treatment, or a treatment with no
       *  code. Fail closed, never post guessed tax. */
      reason:
        | "missing_taxCodeId"
        | "missing_taxCalculation"
        | "invalid_taxCalculation";
    };

// Resolves the tax posture for one transaction. A mapped `taxCodeId` is
// the explicit activation: it posts only together with the accountant's
// price/tax treatment. Both fields absent → today's launch posture (no
// tax posted; `NotApplicable` where QBO requires the field). Either half
// without the other fails closed — a stored half-pair is a
// misconfiguration the operator must fix, not a silent no-tax posting.
export function qboTaxSpecForMapping(
  mapping: { taxCodeId?: string; taxCalculation?: unknown },
  companyCountry: string | undefined
): QboTaxSpec {
  const isUs = companyCountry === "US";
  const taxCodeId =
    typeof mapping.taxCodeId === "string" && mapping.taxCodeId
      ? mapping.taxCodeId
      : undefined;
  if (!taxCodeId) {
    if (mapping.taxCalculation !== undefined) {
      return { ok: false, reason: "missing_taxCodeId" };
    }
    return {
      ok: true,
      globalTaxCalculation: isUs ? undefined : "NotApplicable",
    };
  }
  if (mapping.taxCalculation === undefined || mapping.taxCalculation === null) {
    return { ok: false, reason: "missing_taxCalculation" };
  }
  if (!isQboTaxCalculation(mapping.taxCalculation)) {
    return { ok: false, reason: "invalid_taxCalculation" };
  }
  return {
    ok: true,
    taxCodeId,
    globalTaxCalculation: isUs
      ? undefined
      : mapping.taxCalculation === "inclusive"
        ? "TaxInclusive"
        : "TaxExcluded",
  };
}
