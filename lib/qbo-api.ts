import "server-only";
import {
  buildQboQueryUrl,
  canonicalizeCompanyInfo,
  canonicalizeQboQueryEntities,
  qboApiUrl,
  qboEntityQueryStatement,
  qboErrorForHttpStatus,
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

async function qboApiFetch(input: QboApiFetchInput): Promise<unknown> {
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
  if (!res.ok) {
    throw qboErrorForHttpStatus(res.status, {
      correlationId: res.headers.get("intuit_tid") ?? undefined,
    });
  }
  try {
    return await res.json();
  } catch {
    throw toQboError(new Error("non-JSON response"), "response parsing");
  }
}

export interface QboCompanyInfoResult {
  realmId: string;
  companyName: string;
  country?: string;
}

// CompanyInfo is the canonical "does this connection work" probe — it also
// reports which company the admin authorized, which the admin UI surfaces.
export async function fetchQboCompanyInfo(input: {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
}): Promise<QboCompanyInfoResult> {
  const payload = await qboApiFetch({
    ...input,
    path: `/companyinfo/${encodeURIComponent(input.realmId)}`,
  });
  return canonicalizeCompanyInfo(payload, input.realmId);
}

// Read-only entity discovery used by the future accounting-mapping
// configuration surface. Returns safe summaries only.
export async function queryQboEntities(input: {
  environment: QboEnvironment;
  realmId: string;
  accessToken: string;
  type: QboDiscoveryEntityType;
}): Promise<QboEntitySummary[]> {
  const payload = await qboApiFetch({
    ...input,
    url: buildQboQueryUrl(
      input.environment,
      input.realmId,
      qboEntityQueryStatement(input.type)
    ),
  });
  return canonicalizeQboQueryEntities(input.type, payload);
}
