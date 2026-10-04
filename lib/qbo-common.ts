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

// Where future Stripe/tour revenue posts in QBO. Every value is a QBO
// entity Id discovered from the *connected* company — never hard-coded.
export interface QboAccountingMapping {
  /** Account Stripe/tour receipts clear through (e.g. a clearing or
   *  undeposited-funds style account). */
  stripeClearingAccountId?: string;
  /** Item used for brewery-tour income lines. */
  tourIncomeItemId?: string;
  /** Item used for tasting/flight income lines. */
  tastingIncomeItemId?: string;
  /** Item used for other ad-hoc income lines. */
  otherIncomeItemId?: string;
  /** Customer used when no better QBO customer match exists. */
  fallbackCustomerId?: string;
  /** Optional tax code when the company's tax setup requires one. */
  taxCodeId?: string;
}

export interface QboAccountingMappingView {
  configured: boolean;
  mapping?: QboAccountingMapping;
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

// Deterministic internal sync-record key. The internal source identity is
// the idempotency anchor — a future QBO entity id is correlation only, so
// retries, webhook replays, and browser refreshes can never create two QBO
// transactions for the same source event.
export function qboSyncIdFor(sourceType: string, sourceId: string): string {
  const type = sourceType.trim();
  const id = sourceId.trim();
  if (!type || !id) {
    throw new Error("qboSyncIdFor requires a non-empty sourceType and sourceId.");
  }
  return `${type}:${id}`;
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
      if (
        Object.keys(externalRefs).length >= 20 ||
        typeof value !== "string" ||
        value.length > 128
      ) {
        break;
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
