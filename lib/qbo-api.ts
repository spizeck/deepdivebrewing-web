import "server-only";
import { logInfo } from "@/lib/log";
import {
  buildQboQueryUrl,
  canonicalizeCompanyInfo,
  canonicalizeQboQueryEntities,
  qboApiUrl,
  qboEntityQueryStatement,
  qboErrorForHttpStatus,
  qboQueryRowCount,
  QBO_QUERY_MAX_PAGES,
  QBO_QUERY_PAGE_SIZE,
  toQboError,
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
  const init: RequestInit = { method: input.method ?? "GET", headers };
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
