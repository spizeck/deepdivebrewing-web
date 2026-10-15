// Pure protocol helpers for the QuickBooks Online integration (issue #161):
// OAuth 2.0 request construction, token-response parsing, error
// normalization, webhook signature verification, and payload
// canonicalization. Everything here is dependency-free and unit-testable;
// the server-only modules (lib/qbo.ts, lib/qbo-api.ts, lib/qbo-webhook.ts)
// wire in fetch and Firestore.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { QboError, type QboErrorKind } from "@/lib/qbo-errors";
import {
  QBO_ACCOUNTING_SCOPE,
  QBO_AUTHORIZE_URL,
  QBO_MINOR_VERSION,
  QBO_REVOKE_URL,
  QBO_TOKEN_URL,
  qboApiBaseUrl,
} from "@/lib/qbo-config";
import {
  qboSalesReceiptDocNumber,
  qboSalesReceiptMarker,
  type QboDiscoveryEntityType,
  type QboEntitySummary,
  type QboEnvironment,
} from "@/lib/qbo-common";

// --- OAuth state ---

export const QBO_OAUTH_STATE_BYTES = 32;
// Authorization-code state lives just long enough for a human to click
// through Intuit's consent screens.
export const QBO_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function generateQboOAuthState(): string {
  return randomBytes(QBO_OAUTH_STATE_BYTES).toString("base64url");
}

export type QboOAuthStateVerdict = "ok" | "expired" | "consumed";

export interface QboOAuthStateRecordLike {
  /** Epoch ms when the state stops being valid. */
  expiresAtMs: number;
  /** Epoch ms when the state was consumed, if it has been. */
  consumedAtMs?: number | null;
}

// Single-use, short-lived state: a consumed or expired record is a
// rejection, and an absent record is rejected by the caller before this is
// consulted.
export function classifyQboOAuthState(
  record: QboOAuthStateRecordLike,
  nowMs: number
): QboOAuthStateVerdict {
  if (record.consumedAtMs != null) return "consumed";
  if (record.expiresAtMs <= nowMs) return "expired";
  return "ok";
}

// --- Authorization URL ---

export function buildQboAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(QBO_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("scope", QBO_ACCOUNTING_SCOPE);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  return url.toString();
}

// --- Token endpoint requests ---

export interface QboTokenEndpointRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

export function buildQboTokenExchangeRequest(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): QboTokenEndpointRequest {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  return {
    url: QBO_TOKEN_URL,
    headers: {
      Authorization: basicAuthHeader(input.clientId, input.clientSecret),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  };
}

export function buildQboTokenRefreshRequest(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): QboTokenEndpointRequest {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
  });
  return {
    url: QBO_TOKEN_URL,
    headers: {
      Authorization: basicAuthHeader(input.clientId, input.clientSecret),
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  };
}

// Intuit revokes via JSON on a separate endpoint; either token type may be
// passed (we revoke the refresh token — killing it also kills the ability
// to mint new access tokens).
export function buildQboRevokeRequest(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): { url: string; headers: Record<string, string>; body: string } {
  return {
    url: QBO_REVOKE_URL,
    headers: {
      Authorization: basicAuthHeader(input.clientId, input.clientSecret),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token: input.refreshToken }),
  };
}

// --- Token response ---

export interface QboTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires (Intuit: 3600). */
  accessTokenExpiresInSec: number;
  /** Seconds until the refresh token expires (`x_refresh_token_expires_in`,
   *  ~100 days). Optional — Intuit may omit it. */
  refreshTokenExpiresInSec?: number;
}

export function parseQboTokenResponse(payload: unknown): QboTokenSet {
  if (typeof payload !== "object" || payload === null) {
    throw new QboError("QuickBooks returned a malformed token response.", "unexpected");
  }
  const raw = payload as Record<string, unknown>;
  const accessToken = raw.access_token;
  const refreshToken = raw.refresh_token;
  const expiresIn = raw.expires_in;
  const refreshExpiresIn = raw.x_refresh_token_expires_in;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    typeof refreshToken !== "string" ||
    !refreshToken ||
    typeof expiresIn !== "number" ||
    !(expiresIn > 0)
  ) {
    throw new QboError("QuickBooks returned a malformed token response.", "unexpected");
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresInSec: expiresIn,
    refreshTokenExpiresInSec:
      typeof refreshExpiresIn === "number" && refreshExpiresIn > 0
        ? refreshExpiresIn
        : undefined,
  };
}

// Intuit signals an invalid/revoked grant with `error=invalid_grant` in the
// token endpoint's JSON error body — the trigger for
// reauthorization_required, distinct from a transient failure.
export function qboTokenResponseIsInvalidGrant(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const raw = payload as Record<string, unknown>;
  return raw.error === "invalid_grant";
}

// --- Access-token lifecycle decision ---

// Refresh ahead of the real expiry so an in-flight request never carries a
// token that dies mid-flight.
export const QBO_ACCESS_TOKEN_SKEW_MS = 60_000;
// How long one caller may hold the refresh lease before another may try.
// A crashed refresher blocks refresh for at most this long.
export const QBO_REFRESH_LEASE_MS = 30_000;
// How many times a waiter re-reads the connection record (with a short
// delay) while another caller holds the lease before giving up.
export const QBO_REFRESH_WAIT_ATTEMPTS = 3;
export const QBO_REFRESH_WAIT_DELAY_MS = 750;

// "reauthorize" is not a decision here — it is a persisted connection
// status checked before this runs and surfaced as authorization_expired.
export type QboTokenAction = "use" | "wait" | "refresh";

export interface QboTokenStateLike {
  /** Epoch ms the stored access token expires, or null when absent. */
  accessTokenExpiresAtMs?: number | null;
  /** Epoch ms the refresh lease is held until, or null when free. */
  refreshLeaseUntilMs?: number | null;
}

export function decideQboTokenAction(
  record: QboTokenStateLike,
  nowMs: number
): QboTokenAction {
  const expiresAt = record.accessTokenExpiresAtMs;
  if (
    typeof expiresAt === "number" &&
    expiresAt - QBO_ACCESS_TOKEN_SKEW_MS > nowMs
  ) {
    return "use";
  }
  const leaseUntil = record.refreshLeaseUntilMs;
  if (typeof leaseUntil === "number" && leaseUntil > nowMs) {
    return "wait";
  }
  return "refresh";
}

// --- Error normalization ---

// Maps an Intuit HTTP outcome to the internal taxonomy. `intuit_tid` is the
// provider's correlation id — safe to log, useful for Intuit support.
export function qboErrorForHttpStatus(
  status: number,
  opts: { correlationId?: string; invalidGrant?: boolean } = {}
): QboError {
  const cid = opts.correlationId;
  if (status === 401 || opts.invalidGrant) {
    return new QboError(
      "QuickBooks authorization is no longer valid — reconnect the integration.",
      "authorization_expired",
      409,
      cid
    );
  }
  if (status === 403) {
    return new QboError(
      "QuickBooks denied permission for this operation.",
      "permission_denied",
      403,
      cid
    );
  }
  if (status === 429) {
    return new QboError(
      "QuickBooks is rate limiting requests — try again shortly.",
      "rate_limited",
      429,
      cid
    );
  }
  if (status === 400 || status === 422) {
    return new QboError(
      "QuickBooks rejected the request.",
      "validation",
      400,
      cid
    );
  }
  if (status >= 500) {
    return new QboError(
      "QuickBooks is temporarily unavailable.",
      "unavailable",
      502,
      cid
    );
  }
  return new QboError(
    "QuickBooks returned an unexpected response.",
    "unexpected",
    502,
    cid
  );
}

// Normalizes any failure crossing the provider boundary. Raw response
// bodies are deliberately discarded — they can echo request internals.
// `correlationId` carries Intuit's `intuit_tid` (safe operational
// metadata) so troubleshooting logs keep it even when the failure was a
// transport or parse problem rather than an HTTP status.
export function toQboError(
  error: unknown,
  operation: string,
  opts: { correlationId?: string } = {}
): QboError {
  if (error instanceof QboError) return error;
  const kind: QboErrorKind = "unavailable";
  return new QboError(
    `QuickBooks ${operation} failed unexpectedly — try again shortly.`,
    kind,
    502,
    opts.correlationId
  );
}

// --- Authenticated request helpers ---

export function qboApiUrl(
  environment: QboEnvironment,
  realmId: string,
  path: string
): string {
  const base = qboApiBaseUrl(environment);
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}/v3/company/${encodeURIComponent(realmId)}${normalized}`);
  url.searchParams.set("minorversion", QBO_MINOR_VERSION);
  return url.toString();
}

// QBO's SQL-flavoured query endpoint (GET with the statement encoded).
export function buildQboQueryUrl(
  environment: QboEnvironment,
  realmId: string,
  query: string
): string {
  const url = new URL(qboApiUrl(environment, realmId, "/query"));
  url.searchParams.set("query", query);
  return url.toString();
}

// --- Webhooks ---

// Intuit signs the raw request body with HMAC-SHA256 keyed by the webhook
// verifier token and sends the base64 digest in `intuit-signature`.
export function verifyQboWebhookSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  verifierToken: string
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", verifierToken)
    .update(rawBody, "utf8")
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHeader, "base64");
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// Classic QBO payload (the portal's default format — the opt-in CloudEvents
// format is intentionally not enabled; see docs/operations/quickbooks.md):
//   { "eventNotifications": [
//       { "realmId": "…", "dataChangeEvent": { "entities": [
//           { "name": "Customer", "id": "1", "operation": "Create",
//             "lastUpdated": "…" } ] } } ] }
export interface QboEntityNotification {
  realmId: string;
  entityName: string;
  entityId: string;
  operation: string;
  lastUpdated: string;
}

export function parseQboWebhookNotifications(
  rawBody: string
): QboEntityNotification[] {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return [];
  }
  if (typeof payload !== "object" || payload === null) return [];
  const notifications = (payload as Record<string, unknown>).eventNotifications;
  if (!Array.isArray(notifications)) return [];

  const out: QboEntityNotification[] = [];
  for (const notification of notifications) {
    if (typeof notification !== "object" || notification === null) continue;
    const n = notification as Record<string, unknown>;
    const realmId = typeof n.realmId === "string" ? n.realmId : "";
    const dataChangeEvent = n.dataChangeEvent;
    const entities =
      typeof dataChangeEvent === "object" && dataChangeEvent !== null
        ? (dataChangeEvent as Record<string, unknown>).entities
        : undefined;
    if (!realmId || !Array.isArray(entities)) continue;
    for (const entity of entities) {
      if (typeof entity !== "object" || entity === null) continue;
      const e = entity as Record<string, unknown>;
      const entityName = typeof e.name === "string" ? e.name : "";
      const entityId =
        typeof e.id === "string" || typeof e.id === "number"
          ? String(e.id)
          : "";
      const operation = typeof e.operation === "string" ? e.operation : "";
      const lastUpdated =
        typeof e.lastUpdated === "string" ? e.lastUpdated : "";
      if (!entityName || !entityId) continue;
      out.push({ realmId, entityName, entityId, operation, lastUpdated });
    }
  }
  return out;
}

// Durable dedupe key for one delivered notification. QBO deliveries carry
// no event id, so the content identity (realm + entity + operation +
// timestamp) is the dedupe anchor — a repeated POST of the same
// notification hashes identically.
export function qboWebhookDedupeKey(n: QboEntityNotification): string {
  return createHash("sha256")
    .update(
      [
        n.realmId,
        n.entityName,
        n.entityId,
        n.operation,
        n.lastUpdated,
      ].join("|")
    )
    .digest("hex");
}

// --- Provider payload canonicalization ---

export interface QboCompanyInfo {
  companyName: string;
  country?: string;
}

// GET companyinfo — proves the grant works inside the requested realm and
// reports display metadata (name, country) for the admin UI and the
// connection record. CompanyInfo.Id is a provider entity identifier, NOT
// the OAuth realmId the callback delivered — real sandbox responses carry
// an Id that differs from the realm — so it is deliberately not carried
// into the canonical shape: the connected-company identity comes from the
// OAuth flow, never from this payload, and metadata can never replace it.
// A response without a usable CompanyName is malformed and rejected.
export function canonicalizeCompanyInfo(payload: unknown): QboCompanyInfo {
  const info =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).CompanyInfo
      : undefined;
  const record =
    typeof info === "object" && info !== null
      ? (info as Record<string, unknown>)
      : {};
  const companyName =
    typeof record.CompanyName === "string" ? record.CompanyName : "";
  if (!companyName) {
    throw new QboError(
      "QuickBooks returned a malformed company response.",
      "unexpected"
    );
  }
  const country =
    typeof record.Country === "string" && record.Country
      ? record.Country
      : undefined;
  return { companyName, country };
}

const QBO_ENTITY_QUERIES: Record<
  QboDiscoveryEntityType,
  { statement: string; responseKey: string }
> = {
  account: { statement: "select * from Account", responseKey: "Account" },
  item: { statement: "select * from Item", responseKey: "Item" },
  customer: { statement: "select * from Customer", responseKey: "Customer" },
  "payment-method": {
    statement: "select * from PaymentMethod",
    responseKey: "PaymentMethod",
  },
  "tax-code": { statement: "select * from TaxCode", responseKey: "TaxCode" },
};

// QBO queries default to 100 rows and cap at 1000 — discovery paginates.
export const QBO_QUERY_PAGE_SIZE = 1000;
// Safety bound so a misbehaving provider can never page forever.
export const QBO_QUERY_MAX_PAGES = 10;

// Every Intuit request is bounded. An unbounded fetch would let a stalled
// connection hold a worker's sync claim (or a token-refresh lease) open
// until the runtime kills it — and a successor reclaiming the claim would
// have no way to know the first request was still in flight. Twenty
// seconds is comfortably above Intuit's normal latency and comfortably
// below the sync-claim lease.
export const QBO_REQUEST_TIMEOUT_MS = 20_000;

export function qboEntityQueryStatement(
  type: QboDiscoveryEntityType,
  startPosition?: number,
  maxResults?: number
): string {
  const base = QBO_ENTITY_QUERIES[type].statement;
  if (startPosition === undefined && maxResults === undefined) return base;
  return `${base} startposition ${startPosition ?? 1} maxresults ${maxResults ?? QBO_QUERY_PAGE_SIZE}`;
}

// Raw row count in a QueryResponse page — the pagination signal. Kept
// separate from canonicalization, which may legitimately drop malformed
// rows; a full raw page means another page may exist.
export function qboQueryRowCount(
  type: QboDiscoveryEntityType,
  payload: unknown
): number {
  const response =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).QueryResponse
      : undefined;
  if (typeof response !== "object" || response === null) return 0;
  const rows = (response as Record<string, unknown>)[
    QBO_ENTITY_QUERIES[type].responseKey
  ];
  return Array.isArray(rows) ? rows.length : 0;
}

// Reduces a QueryResponse page to safe display rows. Anything unexpected is
// dropped rather than passed through.
export function canonicalizeQboQueryEntities(
  type: QboDiscoveryEntityType,
  payload: unknown
): QboEntitySummary[] {
  const response =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).QueryResponse
      : undefined;
  if (typeof response !== "object" || response === null) return [];
  const key = QBO_ENTITY_QUERIES[type].responseKey;
  const rows = (response as Record<string, unknown>)[key];
  if (!Array.isArray(rows)) return [];

  const out: QboEntitySummary[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const id =
      typeof r.Id === "string" || typeof r.Id === "number" ? String(r.Id) : "";
    if (!id) continue;
    const name =
      (typeof r.Name === "string" && r.Name) ||
      (typeof r.DisplayName === "string" && r.DisplayName) ||
      (typeof r.FullyQualifiedName === "string" && r.FullyQualifiedName) ||
      "";
    const entityType =
      (typeof r.AccountType === "string" && r.AccountType) ||
      (typeof r.Type === "string" && r.Type) ||
      undefined;
    const detail =
      typeof r.AccountSubType === "string" && r.AccountSubType
        ? r.AccountSubType
        : undefined;
    out.push({
      id,
      name: name || `(${key} ${id})`,
      type: entityType,
      detail,
      active: r.Active !== false,
    });
  }
  return out;
}

// --- Sales Receipt writes (issue #179) ---

// Everything needed to construct one gross Sales Receipt for a settled
// DDB-admin payment. All ids come from the validated accounting mapping
// — never hard-coded account/item/customer ids.
export interface QboSalesReceiptSpec {
  /** Internal payment id — the durable source identity. */
  sourceId: string;
  /** Gross charge amount in integer minor units (cents). */
  amountMinor: number;
  /** Uppercase ISO-4217 code recorded on the payment (today: USD). */
  currency: string;
  /** Settlement instant (payment `paidAt`), epoch ms. */
  paidAtMs: number;
  description?: string;
  clearingAccountId: string;
  incomeItemId: string;
  customerId: string;
  /** QBO PaymentMethod id for `PaymentMethodRef` — resolved from the
   *  accounting mapping by rail (card vs cash), never assumed. */
  paymentMethodId: string;
  /** Human-readable rail note for PrivateNote (e.g. "Cash payment") —
   *  card receipts carry the Stripe refs instead. */
  methodLabel?: string;
  paymentIntentId?: string;
  chargeId?: string;
  /** Mapped TaxCode id for the line's `TaxCodeRef` — present only when
   *  the accountant-verified tax mapping is active (`taxCodeId` +
   *  `taxCalculation` in the accounting mapping, resolved through
   *  `qboTaxSpecForMapping`). Absent → no tax posted; never a guessed
   *  code. See design §10. */
  taxCodeId?: string;
  /** `"NotApplicable"` for a non-US company with no tax code;
   *  `"TaxInclusive"`/`"TaxExcluded"` per the verified price treatment
   *  when a code is mapped; undefined for US companies, which reject
   *  the field entirely. See design §10. */
  globalTaxCalculation?: "NotApplicable" | "TaxInclusive" | "TaxExcluded";
}

const QBO_PRIVATE_NOTE_MAX = 500;
const QBO_LINE_DESCRIPTION_MAX = 500;

// One SalesItemLineDetail line — the shape a RefundReceipt mirrors
// line-for-line in #180 (same DetailType, same TaxCodeRef handling, a
// reduced amountMinor for partial refunds). Shared so the reversal can
// never drift from the sale's line semantics.
export interface QboSalesItemLineSpec {
  /** Line amount in integer minor units — the gross charge for a sale,
   *  the refunded amount for a refund line. */
  amountMinor: number;
  incomeItemId: string;
  description?: string;
  /** Mapped TaxCode id — set only via the accountant-verified mapping
   *  (see QboSalesReceiptSpec.taxCodeId). */
  taxCodeId?: string;
}

export function buildQboSalesItemLine(
  spec: QboSalesItemLineSpec
): Record<string, unknown> {
  const amount = spec.amountMinor / 100;
  return {
    Amount: amount,
    DetailType: "SalesItemLineDetail",
    ...(spec.description
      ? { Description: spec.description.slice(0, QBO_LINE_DESCRIPTION_MAX) }
      : {}),
    SalesItemLineDetail: {
      ItemRef: { value: spec.incomeItemId },
      Qty: 1,
      UnitPrice: amount,
      ...(spec.taxCodeId ? { TaxCodeRef: { value: spec.taxCodeId } } : {}),
    },
  };
}

// Builds the POST /salesreceipt body. The gross customer charge is posted
// (never Stripe net — fees are #181) as a single SalesItemLineDetail line
// against the mapped item, deposited to the rail's mapped deposit account
// (Stripe clearing for card, cash deposit for cash) and carrying the
// rail's mapped PaymentMethodRef. Tax posts only when the caller supplies
// a mapping-resolved taxCodeId — see design §10.
export function buildQboSalesReceiptPayload(
  spec: QboSalesReceiptSpec
): Record<string, unknown> {
  const refs = [
    `Deep Dive Brewing payment ${qboSalesReceiptMarker(spec.sourceId)}`,
    spec.methodLabel ?? null,
    spec.paymentIntentId ? `Stripe PI ${spec.paymentIntentId}` : null,
    spec.chargeId ? `charge ${spec.chargeId}` : null,
  ].filter((part): part is string => part !== null);

  return {
    TxnDate: new Date(spec.paidAtMs).toISOString().slice(0, 10),
    CurrencyRef: { value: spec.currency },
    CustomerRef: { value: spec.customerId },
    DepositToAccountRef: { value: spec.clearingAccountId },
    PaymentMethodRef: { value: spec.paymentMethodId },
    DocNumber: qboSalesReceiptDocNumber(spec.sourceId),
    PrivateNote: refs.join("; ").slice(0, QBO_PRIVATE_NOTE_MAX),
    ...(spec.globalTaxCalculation
      ? { GlobalTaxCalculation: spec.globalTaxCalculation }
      : {}),
    Line: [
      buildQboSalesItemLine({
        amountMinor: spec.amountMinor,
        incomeItemId: spec.incomeItemId,
        description: spec.description,
        taxCodeId: spec.taxCodeId,
      }),
    ],
  };
}

// Canonical shape returned by POST /salesreceipt — only the provider
// entity id crosses the boundary (it is a correlation reference, never
// the dedupe key).
export function canonicalizeQboSalesReceiptCreated(payload: unknown): {
  id: string;
} {
  const receipt =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).SalesReceipt
      : undefined;
  const id =
    typeof receipt === "object" && receipt !== null
      ? (receipt as Record<string, unknown>).Id
      : undefined;
  if (typeof id !== "string" && typeof id !== "number") {
    throw new QboError(
      "QuickBooks returned a malformed sales receipt response.",
      "unexpected"
    );
  }
  return { id: String(id) };
}

const QBO_TXN_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Query statement for provider-side recovery: receipts posted to the
// mapped generic customer on the payment's own settlement date. The
// `TxnDate =` equality filter is the load-bearing bound — a landed
// receipt always carries the TxnDate we posted (paidAt), so the window
// stays small no matter how many receipts the generic customer
// accumulates. PrivateNote is not queryable server-side, so callers
// match the correlation marker locally; pagination is retained as a
// backstop for a busy settlement day. The sort uses TxnDate (a
// documented sortable SalesReceipt field) rather than
// MetaData.CreateTime, whose sortability is not documented.
export function qboSalesReceiptCorrelationQuery(
  customerId: string,
  txnDate: string,
  startPosition = 1,
  maxResults = QBO_QUERY_PAGE_SIZE
): string {
  const safe = customerId.replace(/[^A-Za-z0-9_-]/g, "");
  if (!QBO_TXN_DATE_PATTERN.test(txnDate)) {
    throw new QboError(
      "Sales receipt recovery query requires a YYYY-MM-DD transaction date.",
      "unexpected"
    );
  }
  return `select Id, PrivateNote, TxnDate, DepositToAccountRef from SalesReceipt where CustomerRef = '${safe}' and TxnDate = '${txnDate}' orderby TxnDate desc startposition ${startPosition} maxresults ${maxResults}`;
}

// Raw row count in a SalesReceipt QueryResponse page — the pagination
// signal for the correlation lookup (same contract as qboQueryRowCount
// for discovery entities: canonicalization may drop malformed rows, so
// the raw count decides whether another page may exist).
export function qboSalesReceiptRowCount(payload: unknown): number {
  const response =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).QueryResponse
      : undefined;
  if (typeof response !== "object" || response === null) return 0;
  const rows = (response as Record<string, unknown>).SalesReceipt;
  return Array.isArray(rows) ? rows.length : 0;
}

export interface QboSalesReceiptRef {
  id: string;
  privateNote?: string;
  /** The account the receipt deposited to, when the query returns it —
   *  lets the adopt path fail closed instead of syncing a receipt that
   *  sits outside the expected deposit account. */
  depositToAccountId?: string;
}

export function canonicalizeQboSalesReceiptRefs(
  payload: unknown
): QboSalesReceiptRef[] {
  const response =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).QueryResponse
      : undefined;
  const rows =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>).SalesReceipt
      : undefined;
  if (!Array.isArray(rows)) return [];
  const out: QboSalesReceiptRef[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const id =
      typeof r.Id === "string" || typeof r.Id === "number"
        ? String(r.Id)
        : "";
    if (!id) continue;
    out.push({
      id,
      privateNote:
        typeof r.PrivateNote === "string" ? r.PrivateNote : undefined,
      depositToAccountId:
        accountRefValue(r.DepositToAccountRef) ?? undefined,
    });
  }
  return out;
}

// --- Reconciliation ledger reads (issue #181) ---

// Ledger-side facts for the clearing-account reconciliation: the account's
// own QBO `CurrentBalance` (home-currency — production is USD, verified
// with the mapping) and the transactions that touched the watched
// accounts inside the report window. Read-only protocol support — the
// orchestration in lib/qbo-recon.ts never posts, adjusts, or deletes.

export interface QboAccountBalance {
  id: string;
  name: string;
  accountType?: string;
  /** `CurrentBalance` in the account's currency, integer minor units. */
  balanceMinor: number;
  currency?: string;
}

export function qboAccountBalanceQuery(accountId: string): string {
  const safeId = accountId.replace(/'/g, "");
  return `select Id, Name, AccountType, CurrentBalance, CurrencyRef from Account where Id = '${safeId}'`;
}

export function canonicalizeQboAccountBalance(
  payload: unknown
): QboAccountBalance | null {
  const response =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).QueryResponse
      : undefined;
  const rows =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>).Account
      : undefined;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const id =
    typeof r.Id === "string" || typeof r.Id === "number" ? String(r.Id) : "";
  if (!id || typeof r.CurrentBalance !== "number") return null;
  const currencyRef =
    typeof r.CurrencyRef === "object" && r.CurrencyRef !== null
      ? (r.CurrencyRef as Record<string, unknown>).value
      : undefined;
  return {
    id,
    name: typeof r.Name === "string" ? r.Name : `Account ${id}`,
    accountType: typeof r.AccountType === "string" ? r.AccountType : undefined,
    balanceMinor: Math.round(r.CurrentBalance * 100),
    currency: typeof currencyRef === "string" ? currencyRef : undefined,
  };
}

// Entity types the report scans for clearing-account / fee-account
// activity: bank-feed-style journal adjustments, expense entries
// (Purchase covers QBO's Expense/Check surface), clearing transfers, and
// deposits. Each maps to one query entity name.
export type QboReconActivityEntity =
  | "JournalEntry"
  | "Purchase"
  | "Transfer"
  | "Deposit";

export const QBO_RECON_ACTIVITY_ENTITIES: readonly QboReconActivityEntity[] =
  ["JournalEntry", "Purchase", "Transfer", "Deposit"];

const RECON_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Date-windowed SELECT for one activity entity — the fields needed to
// attribute each row to a watched account and amount it. QBO's query
// grammar cannot filter on line-level AccountRef, so the window narrows
// provider traffic and the canonicalizer + caller do the account match.
export function qboReconActivityQuery(
  entity: QboReconActivityEntity,
  fromDate: string,
  toDate: string,
  startPosition?: number,
  maxResults?: number
): string {
  const from = RECON_DATE.test(fromDate) ? fromDate : "1970-01-01";
  const to = RECON_DATE.test(toDate) ? toDate : "1970-01-01";
  const base = `select * from ${entity} where TxnDate >= '${from}' and TxnDate <= '${to}' orderby TxnDate`;
  return `${base} startposition ${startPosition ?? 1} maxresults ${maxResults ?? QBO_QUERY_PAGE_SIZE}`;
}

// Generic row count for a QueryResponse page keyed by entity name.
export function qboQueryResponseRowCount(
  entity: string,
  payload: unknown
): number {
  const response =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).QueryResponse
      : undefined;
  if (typeof response !== "object" || response === null) return 0;
  const rows = (response as Record<string, unknown>)[entity];
  return Array.isArray(rows) ? rows.length : 0;
}

// One signed account leg of a scanned transaction: `accountId` is the QBO
// AccountRef value, `amountMinor` the signed home-currency effect on that
// account in debit-positive convention — JournalEntry Debit +/Credit −;
// a Purchase debits its expense lines (+) and credits the payment
// `AccountRef` (−TotalAmt), inverted when `Credit: true`; a Deposit
// credits its source lines (−) and debits `DepositToAccountRef`
// (+TotalAmt); a Transfer carries −from/+to legs.
export interface QboReconActivityLeg {
  accountId: string;
  amountMinor: number;
}

export interface QboReconActivityEntry {
  entityType: QboReconActivityEntity;
  id: string;
  txnDate?: string;
  docNumber?: string;
  /** QBO DocNumber/PrivateNote free-text — operator context only. */
  memo?: string;
  legs: QboReconActivityLeg[];
}

function minorUnits(amount: unknown): number | null {
  return typeof amount === "number" ? Math.round(amount * 100) : null;
}

function accountRefValue(ref: unknown): string | null {
  if (typeof ref !== "object" || ref === null) return null;
  const value = (ref as Record<string, unknown>).value;
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

function baseEntryFields(
  entityType: QboReconActivityEntity,
  row: Record<string, unknown>
): Omit<QboReconActivityEntry, "legs"> | null {
  const id =
    typeof row.Id === "string" || typeof row.Id === "number"
      ? String(row.Id)
      : "";
  if (!id) return null;
  return {
    entityType,
    id,
    txnDate: typeof row.TxnDate === "string" ? row.TxnDate : undefined,
    docNumber: typeof row.DocNumber === "string" ? row.DocNumber : undefined,
    memo: typeof row.PrivateNote === "string" ? row.PrivateNote : undefined,
  };
}

// Reduces a QueryResponse page of one activity entity to account legs —
// the only facts the report needs. Anything unexpected drops out rather
// than being passed through or guessed at.
export function canonicalizeQboReconActivity(
  entity: QboReconActivityEntity,
  payload: unknown
): QboReconActivityEntry[] {
  const response =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).QueryResponse
      : undefined;
  const rows =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>)[entity]
      : undefined;
  if (!Array.isArray(rows)) return [];

  const out: QboReconActivityEntry[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const base = baseEntryFields(entity, r);
    if (!base) continue;
    const legs: QboReconActivityLeg[] = [];

    if (entity === "JournalEntry" || entity === "Deposit" || entity === "Purchase") {
      // Line-level legs where the detail type carries an AccountRef.
      const detailKey =
        entity === "JournalEntry"
          ? "JournalEntryLineDetail"
          : entity === "Deposit"
            ? "DepositLineDetail"
            : "AccountBasedExpenseLineDetail";
      // `Credit: true` marks a QBO vendor credit expressed as a Purchase:
      // money flows the other way, so every leg's sign inverts.
      const purchaseCredit = entity === "Purchase" && r.Credit === true;
      const lines = Array.isArray(r.Line) ? r.Line : [];
      for (const line of lines) {
        if (typeof line !== "object" || line === null) continue;
        const l = line as Record<string, unknown>;
        const detail =
          typeof l[detailKey] === "object" && l[detailKey] !== null
            ? (l[detailKey] as Record<string, unknown>)
            : undefined;
        const accountId = detail ? accountRefValue(detail.AccountRef) : null;
        const amount = minorUnits(l.Amount);
        if (!accountId || amount === null) continue;
        // JournalEntry lines sign by PostingType; Purchase expense lines
        // are debits on the expense account (vendor credits invert); a
        // Deposit's lines are the source accounts being credited.
        const signed =
          entity === "JournalEntry"
            ? detail?.PostingType === "Credit"
              ? -amount
              : amount
            : entity === "Deposit" || purchaseCredit
              ? -amount
              : amount;
        legs.push({ accountId, amountMinor: signed });
      }
      // The header account leg is emitted in addition to detail lines —
      // the watched clearing account is usually the paying or receiving
      // account on the header, not a line account, so a Purchase or
      // Deposit touching the clearing account must attribute here even
      // when its lines posted elsewhere.
      if (entity !== "JournalEntry") {
        const accountId = accountRefValue(
          entity === "Purchase" ? r.AccountRef : r.DepositToAccountRef
        );
        const total = minorUnits(r.TotalAmt);
        if (accountId && total !== null) {
          legs.push({
            accountId,
            amountMinor:
              entity === "Deposit" || purchaseCredit ? total : -total,
          });
        }
      }
    } else {
      // Transfer: −FromAccountRef / +ToAccountRef on the txn Amount.
      const amount = minorUnits(r.Amount);
      const fromId = accountRefValue(r.FromAccountRef);
      const toId = accountRefValue(r.ToAccountRef);
      if (amount !== null && fromId) {
        legs.push({ accountId: fromId, amountMinor: -amount });
      }
      if (amount !== null && toId) {
        legs.push({ accountId: toId, amountMinor: amount });
      }
    }

    if (legs.length) out.push({ ...base, legs });
  }
  return out;
}

// --- Payment / Undeposited Funds reads (payout accounting automation) ---

// Canonical facts for one QBO Payment — the Ollie side of payout matching.
// Everything is descriptive evidence (amount, date, deposit target,
// customer, Ollie's own reference); no Stripe identifier exists on these
// records.
export interface QboPaymentFacts {
  id: string;
  txnDate?: string;
  totalMinor: number;
  currency?: string;
  depositToAccountId?: string;
  customerId?: string;
  customerName?: string;
  /** Ollie's reference (PaymentRefNum, e.g. "Ollie Payment #1626166")
   *  or PrivateNote free-text — operator-facing evidence only. */
  refNumber?: string;
  memo?: string;
  linkedTxnIds: string[];
}

// Date-windowed SELECT over Payments. QBO's grammar cannot filter on
// DepositToAccountRef, so the caller filters to the Undeposited Funds
// account after canonicalization.
export function qboPaymentsQuery(
  fromDate: string,
  toDate: string,
  startPosition?: number,
  maxResults?: number
): string {
  const from = RECON_DATE.test(fromDate) ? fromDate : "1970-01-01";
  const to = RECON_DATE.test(toDate) ? toDate : "1970-01-01";
  const base = `select Id, TxnDate, TotalAmt, CurrencyRef, CustomerRef, PaymentRefNum, PrivateNote, DepositToAccountRef, Line from Payment where TxnDate >= '${from}' and TxnDate <= '${to}' orderby TxnDate`;
  return `${base} startposition ${startPosition ?? 1} maxresults ${maxResults ?? QBO_QUERY_PAGE_SIZE}`;
}

// Targeted Payment lookup by PaymentRefNum — used when a Stripe charge's
// Spreedly metadata claims a payment reference that fell outside the
// date-windowed candidate scan. Single-page bound: payment refs are
// effectively unique in this ledger's usage; more than a page of hits
// would itself be an anomaly the matcher flags ambiguous.
export function qboPaymentsByRefNumQuery(
  refNum: string,
  maxResults = 20
): string {
  const safe = refNum.replace(/[^0-9A-Za-z-]/g, "");
  return `select Id, TxnDate, TotalAmt, CurrencyRef, CustomerRef, PaymentRefNum, PrivateNote, DepositToAccountRef, Line from Payment where PaymentRefNum = '${safe}' maxresults ${maxResults}`;
}

export function canonicalizeQboPayments(
  payload: unknown
): QboPaymentFacts[] {
  const response =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).QueryResponse
      : undefined;
  const rows =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>).Payment
      : undefined;
  if (!Array.isArray(rows)) return [];
  const out: QboPaymentFacts[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const id =
      typeof r.Id === "string" || typeof r.Id === "number"
        ? String(r.Id)
        : "";
    const totalMinor = minorUnits(r.TotalAmt);
    if (!id || totalMinor === null) continue;
    const customerRef =
      typeof r.CustomerRef === "object" && r.CustomerRef !== null
        ? (r.CustomerRef as Record<string, unknown>)
        : undefined;
    const currencyRef =
      typeof r.CurrencyRef === "object" && r.CurrencyRef !== null
        ? (r.CurrencyRef as Record<string, unknown>).value
        : undefined;
    const linkedTxnIds: string[] = [];
    if (Array.isArray(r.Line)) {
      for (const line of r.Line) {
        const linked =
          typeof line === "object" && line !== null
            ? (line as Record<string, unknown>).LinkedTxn
            : undefined;
        if (!Array.isArray(linked)) continue;
        for (const link of linked) {
          const txnId =
            typeof link === "object" && link !== null
              ? (link as Record<string, unknown>).TxnId
              : undefined;
          if (typeof txnId === "string" || typeof txnId === "number") {
            linkedTxnIds.push(String(txnId));
          }
        }
      }
    }
    out.push({
      id,
      txnDate: typeof r.TxnDate === "string" ? r.TxnDate : undefined,
      totalMinor,
      currency:
        typeof currencyRef === "string" ? currencyRef.toUpperCase() : undefined,
      depositToAccountId: accountRefValue(r.DepositToAccountRef) ?? undefined,
      customerId: accountRefValue(customerRef) ?? undefined,
      customerName:
        typeof customerRef?.name === "string" ? customerRef.name : undefined,
      refNumber:
        typeof r.PaymentRefNum === "string" ? r.PaymentRefNum : undefined,
      memo: typeof r.PrivateNote === "string" ? r.PrivateNote : undefined,
      linkedTxnIds,
    });
  }
  return out;
}

// Bounded Invoice read by id — resolves the DocNumber of each invoice a
// candidate payment links to. The DocNumber is the invoice number, which
// equals the Ollie order number (verified against real records), giving
// the matcher its Stripe-order↔QBO-invoice identity chain. Read-only.
export interface QboInvoiceFacts {
  id: string;
  docNumber?: string;
}

export function qboInvoicesByIdsQuery(
  ids: string[],
  startPosition?: number,
  maxResults?: number
): string {
  const safe = ids
    .map((id) => `'${id.replace(/[^0-9A-Za-z-]/g, "")}'`)
    .join(",");
  return `select Id, DocNumber from Invoice where Id in (${safe}) orderby Id startposition ${startPosition ?? 1} maxresults ${maxResults ?? QBO_QUERY_PAGE_SIZE}`;
}

export function canonicalizeQboInvoices(payload: unknown): QboInvoiceFacts[] {
  const response =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).QueryResponse
      : undefined;
  const rows =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>).Invoice
      : undefined;
  if (!Array.isArray(rows)) return [];
  const out: QboInvoiceFacts[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const id =
      typeof r.Id === "string" || typeof r.Id === "number"
        ? String(r.Id)
        : "";
    if (!id) continue;
    out.push({
      id,
      docNumber:
        typeof r.DocNumber === "string" ? r.DocNumber : undefined,
    });
  }
  return out;
}

// Locates the company's Undeposited Funds account — Ollie's global
// deposit target and the account payments move *out of* when they are
// reclassified to Stripe Clearing. Fail-closed: zero or several hits
// both return null so matching never guesses which account is UF.
export function qboUndepositedFundsQuery(): string {
  return "select Id, Name, AccountSubType from Account where AccountSubType = 'UndepositedFunds' maxresults 10";
}

export function canonicalizeQboUndepositedFundsAccount(
  payload: unknown
): { id: string; name: string } | null {
  const response =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).QueryResponse
      : undefined;
  const rows =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>).Account
      : undefined;
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row = rows[0];
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const id =
    typeof r.Id === "string" || typeof r.Id === "number" ? String(r.Id) : "";
  if (!id) return null;
  return { id, name: typeof r.Name === "string" ? r.Name : `Account ${id}` };
}

// --- Guarded payout-executor primitives (payout accounting automation) ---
// Write-path builders + canonicalizers for the proposal executor. Every
// write carries a deterministic correlation marker in PrivateNote so a
// retry after an ambiguous outcome can adopt the landed entity instead
// of posting a second one (QBO offers no create-time idempotency key).

// Correlation marker namespaces — deterministic per proposal, matched
// against an entity's PrivateNote during provider-side recovery.
export function qboFeeEntryMarker(
  payoutId: string,
  historical?: boolean
): string {
  // The `-HIST` namespace keeps a historical (pre-cutover share) entry's
  // marker disjoint from the eligible share's — neither memo can satisfy
  // the other's `includes` check, so the shares can never cross-adopt.
  return historical
    ? `DDB-PAYOUT-FEE-HIST:${payoutId}`
    : `DDB-PAYOUT-FEE:${payoutId}`;
}
export function qboPayoutTransferMarker(
  payoutId: string,
  historical?: boolean
): string {
  return historical
    ? `DDB-PAYOUT-XFER-HIST:${payoutId}`
    : `DDB-PAYOUT-XFER:${payoutId}`;
}

// Single-Payment read for apply-time revalidation + sparse update: the
// executor re-reads the payment immediately before moving it, so the
// SyncToken and deposit account it acts on are current facts, never a
// cached match result.
export interface QboPaymentRecord {
  id: string;
  syncToken: string;
  txnDate?: string;
  totalMinor: number;
  currency?: string;
  depositToAccountId?: string;
  customerId?: string;
  refNumber?: string;
}

export function qboPaymentByIdQuery(id: string): string {
  const safe = id.replace(/[^0-9A-Za-z-]/g, "");
  return `select Id, SyncToken, TxnDate, TotalAmt, CurrencyRef, CustomerRef, PaymentRefNum, DepositToAccountRef, Line from Payment where Id = '${safe}'`;
}

export function canonicalizeQboPayment(
  payload: unknown
): QboPaymentRecord | null {
  const response =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).QueryResponse
      : undefined;
  const rows =
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>).Payment
      : undefined;
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const id =
    typeof r.Id === "string" || typeof r.Id === "number" ? String(r.Id) : "";
  const totalMinor = minorUnits(r.TotalAmt);
  const syncToken =
    typeof r.SyncToken === "string" || typeof r.SyncToken === "number"
      ? String(r.SyncToken)
      : "";
  if (!id || !syncToken || totalMinor === null) return null;
  const currencyRef =
    typeof r.CurrencyRef === "object" && r.CurrencyRef !== null
      ? (r.CurrencyRef as Record<string, unknown>).value
      : undefined;
  const customerRef =
    typeof r.CustomerRef === "object" && r.CustomerRef !== null
      ? (r.CustomerRef as Record<string, unknown>)
      : undefined;
  return {
    id,
    syncToken,
    txnDate: typeof r.TxnDate === "string" ? r.TxnDate : undefined,
    totalMinor,
    currency:
      typeof currencyRef === "string" ? currencyRef.toUpperCase() : undefined,
    depositToAccountId: accountRefValue(r.DepositToAccountRef) ?? undefined,
    customerId: accountRefValue(customerRef) ?? undefined,
    refNumber:
      typeof r.PaymentRefNum === "string" ? r.PaymentRefNum : undefined,
  };
}

// Sparse update payload — moves a Payment's deposit target without
// touching its lines, customer, or invoice links. `sparse: true` is
// required: a full update would demand every field.
export function buildQboPaymentDepositUpdate(input: {
  paymentId: string;
  syncToken: string;
  depositToAccountId: string;
}): Record<string, unknown> {
  return {
    Id: input.paymentId,
    SyncToken: input.syncToken,
    sparse: true,
    DepositToAccountRef: { value: input.depositToAccountId },
  };
}

export interface QboJournalLineSpec {
  postingType: "Debit" | "Credit";
  accountId: string;
  amountMinor: number;
  description?: string;
}

// Two-legged JournalEntry payload — the Stripe fee posting (debit fee
// expense, credit clearing). Home-currency amounts only; payout
// proposals are never built for foreign-currency lines.
export function buildQboJournalEntryPayload(input: {
  txnDate: string;
  privateNote: string;
  lines: QboJournalLineSpec[];
}): Record<string, unknown> {
  return {
    TxnDate: input.txnDate,
    PrivateNote: input.privateNote,
    Line: input.lines.map((line) => ({
      DetailType: "JournalEntryLineDetail",
      Amount: line.amountMinor / 100,
      Description: line.description,
      JournalEntryLineDetail: {
        PostingType: line.postingType,
        AccountRef: { value: line.accountId },
      },
    })),
  };
}

// Transfer payload — the payout leg: FROM the Stripe clearing account
// (credit) TO the configured payout/bank account (debit).
export function buildQboTransferPayload(input: {
  txnDate: string;
  amountMinor: number;
  fromAccountId: string;
  toAccountId: string;
  privateNote: string;
}): Record<string, unknown> {
  return {
    TxnDate: input.txnDate,
    Amount: input.amountMinor / 100,
    FromAccountRef: { value: input.fromAccountId },
    ToAccountRef: { value: input.toAccountId },
    PrivateNote: input.privateNote,
  };
}

// Generic create/update result — QBO echoes the persisted entity under
// its type name ({JournalEntry: {Id, SyncToken, ...}}).
export function canonicalizeQboTxnWriteResult(
  entity: "Payment" | "JournalEntry" | "Transfer",
  payload: unknown
): { id: string; syncToken?: string } | null {
  const row =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)[entity]
      : undefined;
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const id =
    typeof r.Id === "string" || typeof r.Id === "number" ? String(r.Id) : "";
  if (!id) return null;
  const syncToken =
    typeof r.SyncToken === "string" || typeof r.SyncToken === "number"
      ? String(r.SyncToken)
      : undefined;
  return { id, syncToken };
}
