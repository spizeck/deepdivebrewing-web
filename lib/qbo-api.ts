import "server-only";
import { logInfo } from "@/lib/log";
import {
  buildQboQueryUrl,
  canonicalizeCompanyInfo,
  canonicalizeQboAccountBalance,
  canonicalizeQboPayments,
  canonicalizeQboQueryEntities,
  canonicalizeQboReconActivity,
  canonicalizeQboSalesReceiptCreated,
  canonicalizeQboSalesReceiptRefs,
  canonicalizeQboUndepositedFundsAccount,
  qboAccountBalanceQuery,
  qboApiUrl,
  qboEntityQueryStatement,
  qboErrorForHttpStatus,
  qboPaymentsQuery,
  qboQueryResponseRowCount,
  qboQueryRowCount,
  qboReconActivityQuery,
  qboUndepositedFundsQuery,
  canonicalizeQboInvoices,
  qboInvoicesByIdsQuery,
  qboSalesReceiptCorrelationQuery,
  qboSalesReceiptRowCount,
  QBO_QUERY_MAX_PAGES,
  QBO_QUERY_PAGE_SIZE,
  QBO_REQUEST_TIMEOUT_MS,
  toQboError,
  type QboAccountBalance,
  type QboInvoiceFacts,
  type QboPaymentFacts,
  type QboReconActivityEntity,
  type QboReconActivityEntry,
} from "@/lib/qbo-protocol";
import type {
  QboDiscoveryEntityType,
  QboEntitySummary,
  QboEnvironment,
} from "@/lib/qbo-common";

// Low-level QuickBooks API client boundary (issue #161). This is the only
// module that speaks to the Intuit v3 endpoints: callers pass a resolved
// access token (token lifecycle lives in lib/qbo.ts) and get back canonical
// shapes or a normalized QboError. Raw provider payloads never leave this
// module.

interface QboApiFetchInput {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
  /** Path under /v3/company/{realmId}, or a fully-built URL (query). */
  path?: string;
  url?: string;
  method?: "GET" | "POST";
  body?: unknown;
}

interface QboApiFetchResult {
  payload: unknown;
  /** Intuit's per-request correlation id (`intuit_tid` response header).
   *  Safe operational metadata — it identifies the provider request for
   *  Intuit support without exposing any credential or payload. */
  correlationId?: string;
}

async function qboApiFetch(
  input: QboApiFetchInput
): Promise<QboApiFetchResult> {
  const url =
    input.url ??
    qboApiUrl(input.environment, input.realmId, input.path ?? "");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.accessToken}`,
    Accept: "application/json",
  };
  const init: RequestInit = {
    method: input.method ?? "GET",
    headers,
    // Bounded so a stalled request cannot outlive the caller's sync
    // claim; an aborted create is ambiguous (the write may still land)
    // and is recovered by the correlation-marker lookup on retry.
    signal: AbortSignal.timeout(QBO_REQUEST_TIMEOUT_MS),
  };
  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(input.body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    throw toQboError(error, "request");
  }
  // Captured before status/body handling so error and parse-failure paths
  // keep the provider transaction id.
  const correlationId = res.headers.get("intuit_tid") ?? undefined;
  if (!res.ok) {
    throw qboErrorForHttpStatus(res.status, { correlationId });
  }
  try {
    return { payload: await res.json(), correlationId };
  } catch {
    throw toQboError(new Error("non-JSON response"), "response parsing", {
      correlationId,
    });
  }
}

export interface QboCompanyInfoResult {
  companyName: string;
  country?: string;
}

// CompanyInfo is the canonical "does this connection work" probe — the
// request itself is scoped to the connected realm, and the response
// provides the display metadata (company name, country) the admin UI
// surfaces. The realm id is not derived from the response: CompanyInfo.Id
// is provider metadata, never the OAuth realm identity.
export async function fetchQboCompanyInfo(input: {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
}): Promise<QboCompanyInfoResult> {
  const { payload, correlationId } = await qboApiFetch({
    ...input,
    path: `/companyinfo/${encodeURIComponent(input.realmId)}`,
  });
  // CompanyInfo is the connect/health probe — the Intuit transaction id
  // here is what an operator quotes when troubleshooting a connection.
  logInfo("qbo.api.companyinfo", {
    environment: input.environment,
    correlationId,
  });
  return canonicalizeCompanyInfo(payload);
}

// Read-only entity discovery used by the future accounting-mapping
// configuration surface. Returns safe summaries only. Pages through the
// query endpoint — QBO defaults to 100 rows when no MAXRESULTS is given,
// so a real company's chart of accounts or customer list would silently
// truncate on a single bare select.
export async function queryQboEntities(input: {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
  type: QboDiscoveryEntityType;
}): Promise<QboEntitySummary[]> {
  const out: QboEntitySummary[] = [];
  // Log once per discovery run, not per page — a paged query can make up
  // to QBO_QUERY_MAX_PAGES requests and each page carries its own tid.
  // The first page's tid identifies the operation for support purposes.
  let correlationId: string | undefined;
  let pages = 0;
  for (let page = 0; page < QBO_QUERY_MAX_PAGES; page++) {
    const result = await qboApiFetch({
      ...input,
      url: buildQboQueryUrl(
        input.environment,
        input.realmId,
        qboEntityQueryStatement(
          input.type,
          page * QBO_QUERY_PAGE_SIZE + 1,
          QBO_QUERY_PAGE_SIZE
        )
      ),
    });
    pages++;
    correlationId ??= result.correlationId;
    out.push(...canonicalizeQboQueryEntities(input.type, result.payload));
    if (qboQueryRowCount(input.type, result.payload) < QBO_QUERY_PAGE_SIZE)
      break;
  }
  logInfo("qbo.api.entities", {
    environment: input.environment,
    type: input.type,
    pages,
    correlationId,
  });
  return out;
}

// --- Sales Receipt writes (issue #179) ---

export interface QboSalesReceiptCreateResult {
  id: string;
  correlationId?: string;
}

// Creates one Sales Receipt. The only bookkeeping write in the entire
// integration — callers supply a fully-built, mapping-resolved payload
// from buildQboSalesReceiptPayload; this boundary validates nothing about
// accounting, only transport and response shape. QBO offers no
// idempotency key on create, so retry dedupe is the sync record plus the
// correlation-marker query below.
export async function createQboSalesReceipt(input: {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
  payload: Record<string, unknown>;
}): Promise<QboSalesReceiptCreateResult> {
  const { payload, correlationId } = await qboApiFetch({
    environment: input.environment,
    realmId: input.realmId,
    accessToken: input.accessToken,
    path: "/salesreceipt",
    method: "POST",
    body: input.payload,
  });
  const created = canonicalizeQboSalesReceiptCreated(payload);
  logInfo("qbo.api.salesreceipt_created", {
    environment: input.environment,
    correlationId,
  });
  return { ...created, correlationId };
}

// Provider-side recovery lookup: find a Sales Receipt already carrying
// this payment's correlation marker. Runs before every create so a
// retry after an ambiguous outcome (write landed, response lost) adopts
// the existing receipt instead of posting a second one. Pages through
// the customer's receipts — a single page could miss a receipt with an
// older or backdated TxnDate.
export async function findQboSalesReceiptForMarker(input: {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
  customerId: string;
  /** The receipt's posted TxnDate (YYYY-MM-DD) — the payment's paidAt. */
  txnDate: string;
  marker: string;
}): Promise<QboSalesReceiptCreateResult | null> {
  let correlationId: string | undefined;
  for (let page = 0; page < QBO_QUERY_MAX_PAGES; page++) {
    const { payload, correlationId: tid } = await qboApiFetch({
      environment: input.environment,
      realmId: input.realmId,
      accessToken: input.accessToken,
      url: buildQboQueryUrl(
        input.environment,
        input.realmId,
        qboSalesReceiptCorrelationQuery(
          input.customerId,
          input.txnDate,
          page * QBO_QUERY_PAGE_SIZE + 1,
          QBO_QUERY_PAGE_SIZE
        )
      ),
    });
    correlationId ??= tid;
    const match = canonicalizeQboSalesReceiptRefs(payload).find((ref) =>
      ref.privateNote?.includes(input.marker)
    );
    if (match) {
      logInfo("qbo.api.salesreceipt_lookup", {
        environment: input.environment,
        found: true,
        correlationId,
      });
      return { id: match.id, correlationId };
    }
    if (qboSalesReceiptRowCount(payload) < QBO_QUERY_PAGE_SIZE) break;
  }
  logInfo("qbo.api.salesreceipt_lookup", {
    environment: input.environment,
    found: false,
    correlationId,
  });
  return null;
}

// --- Reconciliation ledger reads (issue #181) — read-only ---

// One account's ledger balance (the clearing account and, when mapped,
// the fee expense account in the reconciliation report). A stale or
// unresolvable id returns null rather than failing the report — a
// missing mapping degrades the QBO leg, it must not hide Stripe facts.
export async function fetchQboAccountBalance(input: {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
  accountId: string;
}): Promise<QboAccountBalance | null> {
  const { payload, correlationId } = await qboApiFetch({
    environment: input.environment,
    realmId: input.realmId,
    accessToken: input.accessToken,
    url: buildQboQueryUrl(
      input.environment,
      input.realmId,
      qboAccountBalanceQuery(input.accountId)
    ),
  });
  const balance = canonicalizeQboAccountBalance(payload);
  logInfo("qbo.api.account_balance", {
    environment: input.environment,
    found: Boolean(balance),
    correlationId,
  });
  return balance;
}

export interface QboReconActivityPage {
  rows: QboReconActivityEntry[];
  /** True when pagination hit the page cap — the window may hold more. */
  truncated: boolean;
}

// Date-windowed scan of one activity entity (JournalEntry / Purchase /
// Transfer / Deposit). The reconciliation report uses it to inspect
// whether fees, adjustments, or clearing transfers already exist in the
// books before any new entry is proposed — inspection, never posting.
export async function queryQboReconActivity(input: {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
  entity: QboReconActivityEntity;
  fromDate: string;
  toDate: string;
}): Promise<QboReconActivityPage> {
  const rows: QboReconActivityEntry[] = [];
  let truncated = false;
  let correlationId: string | undefined;
  for (let page = 0; page < QBO_QUERY_MAX_PAGES; page++) {
    const { payload, correlationId: tid } = await qboApiFetch({
      environment: input.environment,
      realmId: input.realmId,
      accessToken: input.accessToken,
      url: buildQboQueryUrl(
        input.environment,
        input.realmId,
        qboReconActivityQuery(
          input.entity,
          input.fromDate,
          input.toDate,
          page * QBO_QUERY_PAGE_SIZE + 1,
          QBO_QUERY_PAGE_SIZE
        )
      ),
    });
    correlationId ??= tid;
    rows.push(...canonicalizeQboReconActivity(input.entity, payload));
    if (
      qboQueryResponseRowCount(input.entity, payload) < QBO_QUERY_PAGE_SIZE
    ) {
      break;
    }
    if (page === QBO_QUERY_MAX_PAGES - 1) truncated = true;
  }
  logInfo("qbo.api.recon_activity", {
    environment: input.environment,
    entity: input.entity,
    rows: rows.length,
    truncated,
    correlationId,
  });
  return { rows, truncated };
}

// Windowed Payment read for the payout-matching engine (payout accounting
// automation). Read-only — returns every QBO Payment in the window; the
// caller filters to the Undeposited Funds account.
export async function queryQboPayments(input: {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
  fromDate: string;
  toDate: string;
  maxPages?: number;
}): Promise<{ rows: QboPaymentFacts[]; truncated: boolean }> {
  const maxPages = input.maxPages ?? QBO_QUERY_MAX_PAGES;
  const rows: QboPaymentFacts[] = [];
  let truncated = false;
  let correlationId: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { payload, correlationId: tid } = await qboApiFetch({
      environment: input.environment,
      realmId: input.realmId,
      accessToken: input.accessToken,
      url: buildQboQueryUrl(
        input.environment,
        input.realmId,
        qboPaymentsQuery(
          input.fromDate,
          input.toDate,
          page * QBO_QUERY_PAGE_SIZE + 1,
          QBO_QUERY_PAGE_SIZE
        )
      ),
    });
    correlationId ??= tid;
    rows.push(...canonicalizeQboPayments(payload));
    const response =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).QueryResponse
        : undefined;
    const rowCount =
      typeof response === "object" && response !== null
        ? ((response as Record<string, unknown>).Payment as unknown[] | undefined)?.length ?? 0
        : 0;
    if (rowCount < QBO_QUERY_PAGE_SIZE) break;
    if (page === maxPages - 1) truncated = true;
  }
  logInfo("qbo.api.payments", {
    environment: input.environment,
    rows: rows.length,
    truncated,
    correlationId,
  });
  return { rows, truncated };
}

// Bounded Invoice read by id for the payout-matching engine: resolves
// the DocNumber of each invoice a candidate payment links to, which is
// the invoice number — equal to the Ollie order number. Read-only.
export async function queryQboInvoices(input: {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
  ids: string[];
}): Promise<QboInvoiceFacts[]> {
  if (input.ids.length === 0) return [];
  const rows: QboInvoiceFacts[] = [];
  let correlationId: string | undefined;
  for (let page = 0; page < QBO_QUERY_MAX_PAGES; page++) {
    const result = await qboApiFetch({
      environment: input.environment,
      realmId: input.realmId,
      accessToken: input.accessToken,
      url: buildQboQueryUrl(
        input.environment,
        input.realmId,
        qboInvoicesByIdsQuery(
          input.ids,
          page * QBO_QUERY_PAGE_SIZE + 1,
          QBO_QUERY_PAGE_SIZE
        )
      ),
    });
    correlationId ??= result.correlationId;
    rows.push(...canonicalizeQboInvoices(result.payload));
    const response =
      typeof result.payload === "object" && result.payload !== null
        ? (result.payload as Record<string, unknown>).QueryResponse
        : undefined;
    const rowCount =
      typeof response === "object" && response !== null
        ? ((response as Record<string, unknown>).Invoice as unknown[] | undefined)?.length ?? 0
        : 0;
    if (rowCount < QBO_QUERY_PAGE_SIZE) break;
  }
  logInfo("qbo.api.invoices", {
    environment: input.environment,
    ids: input.ids.length,
    rows: rows.length,
    correlationId,
  });
  return rows;
}

// Discovers the company's Undeposited Funds account (Ollie's global
// deposit target). Returns null when the company has none or several —
// matching then runs with no UF filter rather than guessing.
export async function findQboUndepositedFundsAccount(input: {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
}): Promise<{ id: string; name: string } | null> {
  const { payload } = await qboApiFetch({
    environment: input.environment,
    realmId: input.realmId,
    accessToken: input.accessToken,
    url: buildQboQueryUrl(
      input.environment,
      input.realmId,
      qboUndepositedFundsQuery()
    ),
  });
  return canonicalizeQboUndepositedFundsAccount(payload);
}
