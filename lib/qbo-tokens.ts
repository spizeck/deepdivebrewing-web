import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { logError, logInfo, logWarn } from "@/lib/log";
import {
  decryptQboSecret,
  encryptQboSecret,
  getQboEncryptionKey,
} from "@/lib/qbo-crypto";
import { loadQboConfig } from "@/lib/qbo-config";
import { QboError } from "@/lib/qbo-errors";
import {
  buildQboTokenRefreshRequest,
  decideQboTokenAction,
  parseQboTokenResponse,
  qboErrorForHttpStatus,
  qboTokenResponseIsInvalidGrant,
  QBO_REFRESH_LEASE_MS,
  QBO_REFRESH_WAIT_ATTEMPTS,
  QBO_REFRESH_WAIT_DELAY_MS,
  type QboTokenEndpointRequest,
  type QboTokenSet,
} from "@/lib/qbo-protocol";
import {
  QBO_CONNECTIONS_COLLECTION,
  type QboEnvironment,
  type QboHealthStatus,
} from "@/lib/qbo-common";

// QuickBooks connection record + access-token lifecycle (issue #161),
// split from lib/qbo.ts so the mapping module (lib/qbo-mapping.ts) can
// acquire tokens without an import cycle.
//
// Token material is AES-256-GCM encrypted (lib/qbo-crypto.ts) and never
// leaves the server.

export interface QboConnectionDoc {
  environment: QboEnvironment;
  status: "connected" | "reauthorization_required" | "disconnected";
  realmId?: string;
  companyName?: string;
  companyCountry?: string;
  accessTokenEnc?: string;
  refreshTokenEnc?: string;
  accessTokenExpiresAt?: Timestamp;
  refreshTokenExpiresAt?: Timestamp;
  refreshLeaseUntil?: Timestamp;
  connectedAt?: Timestamp;
  connectedByUid?: string;
  connectedByEmail?: string;
  lastCheckAt?: Timestamp;
  lastCheckStatus?: QboHealthStatus;
  disconnectedAt?: Timestamp;
  disconnectedByUid?: string;
  updatedAt?: Timestamp;
}

export function qboConnectionRef(environment: QboEnvironment) {
  return getFirebaseAdminDb()
    .collection(QBO_CONNECTIONS_COLLECTION)
    .doc(environment);
}

// Defense-in-depth: the document id is the environment, but a hand-edited
// or migrated record claiming a different environment must never be used —
// a preview deployment must be incapable of touching the production realm.
export function usableQboConnection(
  data: FirebaseFirestore.DocumentData | undefined,
  environment: QboEnvironment
): QboConnectionDoc | null {
  if (!data) return null;
  if (data.environment && data.environment !== environment) {
    logWarn("qbo.connection_environment_mismatch", { environment });
    return null;
  }
  return data as QboConnectionDoc;
}

// Calls Intuit's token endpoint. 4xx/5xx and invalid_grant bodies are
// normalized into QboError; the raw body never propagates.
export async function requestQboTokens(
  request: QboTokenEndpointRequest,
  operation: string
): Promise<QboTokenSet> {
  let res: Response;
  try {
    res = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });
  } catch {
    throw new QboError(
      `QuickBooks ${operation} could not be reached.`,
      "unavailable"
    );
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // Non-JSON body — only meaningful through the status code.
  }
  if (!res.ok) {
    throw qboErrorForHttpStatus(res.status, {
      correlationId: res.headers.get("intuit_tid") ?? undefined,
      invalidGrant: qboTokenResponseIsInvalidGrant(payload),
    });
  }
  return parseQboTokenResponse(payload);
}

type TokenDecision =
  | { action: "use"; accessToken: string; realmId: string }
  | { action: "wait" }
  | { action: "refresh"; refreshToken: string; realmId: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Canonical token-acquisition helper — the only place an access token
// should be obtained. Concurrent refresh attempts converge on a short
// Firestore lease: the lease holder refreshes and persists the rotated
// refresh token; waiters re-read until the new token lands. QuickBooks
// rotates the refresh token on every refresh — the newest response always
// wins and the older token is never reused.
export async function getQuickBooksAccessToken(): Promise<{
  accessToken: string;
  realmId: string;
}> {
  const config = loadQboConfig();
  const key = getQboEncryptionKey();
  const db = getFirebaseAdminDb();
  const ref = qboConnectionRef(config.environment);

  for (let attempt = 0; attempt <= QBO_REFRESH_WAIT_ATTEMPTS; attempt++) {
    const decision = await db.runTransaction<TokenDecision>(async (tx) => {
      const snap = await tx.get(ref);
      const record = usableQboConnection(snap.data(), config.environment);
      if (!record || record.status === "disconnected" || !record.refreshTokenEnc) {
        throw new QboError("QuickBooks is not connected.", "validation", 409);
      }
      if (record.status === "reauthorization_required") {
        throw new QboError(
          "QuickBooks authorization needs to be renewed — reconnect the integration.",
          "authorization_expired"
        );
      }
      const action = decideQboTokenAction(
        {
          accessTokenExpiresAtMs:
            record.accessTokenExpiresAt?.toMillis() ?? null,
          refreshLeaseUntilMs: record.refreshLeaseUntil?.toMillis() ?? null,
        },
        Date.now()
      );
      const realmId = record.realmId ?? "";
      if (action === "use") {
        return {
          action,
          accessToken: decryptQboSecret(record.accessTokenEnc ?? "", key),
          realmId,
        };
      }
      if (action === "wait") return { action };
      tx.update(ref, {
        refreshLeaseUntil: Timestamp.fromMillis(
          Date.now() + QBO_REFRESH_LEASE_MS
        ),
      });
      return {
        action,
        refreshToken: decryptQboSecret(record.refreshTokenEnc, key),
        realmId,
      };
    });

    if (decision.action === "use") {
      return {
        accessToken: decision.accessToken,
        realmId: decision.realmId,
      };
    }
    if (decision.action === "wait") {
      await delay(QBO_REFRESH_WAIT_DELAY_MS);
      continue;
    }

    // Lease holder: refresh outside the transaction (no provider IO inside
    // Firestore transactions), then persist the rotated tokens atomically.
    try {
      const tokens = await requestQboTokens(
        buildQboTokenRefreshRequest({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          refreshToken: decision.refreshToken,
        }),
        "token refresh"
      );
      const nowMs = Date.now();
      await db.runTransaction(async (tx) => {
        tx.update(ref, {
          accessTokenEnc: encryptQboSecret(tokens.accessToken, key),
          refreshTokenEnc: encryptQboSecret(tokens.refreshToken, key),
          accessTokenExpiresAt: Timestamp.fromMillis(
            nowMs + tokens.accessTokenExpiresInSec * 1000
          ),
          refreshTokenExpiresAt: tokens.refreshTokenExpiresInSec
            ? Timestamp.fromMillis(
                nowMs + tokens.refreshTokenExpiresInSec * 1000
              )
            : FieldValue.delete(),
          refreshLeaseUntil: FieldValue.delete(),
          status: "connected",
          updatedAt: Timestamp.fromMillis(nowMs),
        });
      });
      logInfo("qbo.token.refreshed", { environment: config.environment });
      return { accessToken: tokens.accessToken, realmId: decision.realmId };
    } catch (error) {
      const isRevoked =
        error instanceof QboError && error.kind === "authorization_expired";
      const cleanup: Record<string, unknown> = {
        refreshLeaseUntil: FieldValue.delete(),
        updatedAt: Timestamp.now(),
      };
      if (isRevoked) cleanup.status = "reauthorization_required";
      await ref.update(cleanup).catch(() => {});
      if (isRevoked) {
        logWarn("qbo.token_refresh_failed", {
          environment: config.environment,
          reason: "authorization_expired",
        });
      } else {
        logError("qbo.token_refresh_failed", error, {
          environment: config.environment,
        });
      }
      throw error;
    }
  }

  throw new QboError(
    "QuickBooks token refresh is in progress — try again shortly.",
    "unavailable"
  );
}
