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
  paymentIntentId?: string;
  chargeId?: string;
  /** `"NotApplicable"` for non-US companies (QBO requires the field on
   *  sales transactions there); undefined for US companies, which reject
   *  it. Tax posting itself stays disabled — see design §10. */
  globalTaxCalculation?: "NotApplicable";
}

const QBO_PRIVATE_NOTE_MAX = 500;
const QBO_LINE_DESCRIPTION_MAX = 500;

// Builds the POST /salesreceipt body. The gross customer charge is posted
// (never Stripe net — fees are #181) as a single SalesItemLineDetail line
// against the mapped item, deposited to the mapped Stripe clearing/
// balance account. No TaxCodeRef is ever sent: tax policy for the CW
// company is an open accountant question (#184).
export function buildQboSalesReceiptPayload(
  spec: QboSalesReceiptSpec
): Record<string, unknown> {
  const gross = spec.amountMinor / 100;
  const refs = [
    `Deep Dive Brewing payment ${qboSalesReceiptMarker(spec.sourceId)}`,
    spec.paymentIntentId ? `Stripe PI ${spec.paymentIntentId}` : null,
    spec.chargeId ? `charge ${spec.chargeId}` : null,
  ].filter((part): part is string => part !== null);

  return {
    TxnDate: new Date(spec.paidAtMs).toISOString().slice(0, 10),
    CurrencyRef: { value: spec.currency },
    CustomerRef: { value: spec.customerId },
    DepositToAccountRef: { value: spec.clearingAccountId },
    DocNumber: qboSalesReceiptDocNumber(spec.sourceId),
    PrivateNote: refs.join("; ").slice(0, QBO_PRIVATE_NOTE_MAX),
    ...(spec.globalTaxCalculation
      ? { GlobalTaxCalculation: spec.globalTaxCalculation }
      : {}),
    Line: [
      {
        Amount: gross,
        DetailType: "SalesItemLineDetail",
        ...(spec.description
          ? { Description: spec.description.slice(0, QBO_LINE_DESCRIPTION_MAX) }
          : {}),
        SalesItemLineDetail: {
          ItemRef: { value: spec.incomeItemId },
          Qty: 1,
          UnitPrice: gross,
        },
      },
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

// Query statement for provider-side recovery: recent receipts posted to
// the mapped generic customer. PrivateNote is not queryable server-side,
// so the statement bounds the window and callers match the correlation
// marker locally. A landed-but-untracked write is always recent at retry
// time, so the most recent receipts are sufficient.
export function qboSalesReceiptCorrelationQuery(
  customerId: string
): string {
  const safe = customerId.replace(/[^A-Za-z0-9_-]/g, "");
  return `select Id, PrivateNote, TxnDate from SalesReceipt where CustomerRef = '${safe}' orderby TxnDate desc maxresults 25`;
}

export interface QboSalesReceiptRef {
  id: string;
  privateNote?: string;
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
    });
  }
  return out;
}
