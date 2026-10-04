import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { logAdminAudit } from "@/lib/admin-audit";
import type { AdminActor } from "@/lib/admin-auth";
import type { AdminAuditRecord } from "@/lib/admin-types";
import { logError, logInfo, logWarn } from "@/lib/log";
import { toIsoString } from "@/lib/admin-serializers";
import { fetchQboCompanyInfo } from "@/lib/qbo-api";
import { getQboMappingConfigured } from "@/lib/qbo-mapping";
import {
  decryptQboSecret,
  encryptQboSecret,
  getQboEncryptionKey,
} from "@/lib/qbo-crypto";
import {
  isQboConfigured,
  getQboEnvironment,
  loadQboConfig,
} from "@/lib/qbo-config";
import { QboError } from "@/lib/qbo-errors";
import {
  abbreviateRealmId,
  qboEnvironmentLabel,
  QBO_OAUTH_STATES_COLLECTION,
  type QboAdminView,
  type QboEnvironment,
  type QboHealthStatus,
} from "@/lib/qbo-common";
import {
  buildQboAuthorizationUrl,
  buildQboRevokeRequest,
  buildQboTokenExchangeRequest,
  classifyQboOAuthState,
  generateQboOAuthState,
  QBO_OAUTH_STATE_TTL_MS,
} from "@/lib/qbo-protocol";
import {
  getQuickBooksAccessToken,
  qboConnectionRef,
  requestQboTokens,
  usableQboConnection,
} from "@/lib/qbo-tokens";

// QuickBooks Online connection lifecycle (issue #161) — the server-only
// orchestration behind /api/admin/quickbooks/* and the QBO API client.
//
// Storage model (every collection deny-all to Firebase clients):
//   qboConnections/{environment} — the live connection for the configured
//     QBO_ENVIRONMENT (sandbox and production can never collide even
//     though preview and production share this Firestore project).
//   qboOauthStates/{state} — one-time authorization-request state.

interface QboOAuthStateDoc {
  uid: string;
  email?: string;
  environment: QboEnvironment;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  consumedAt?: Timestamp;
}

async function auditQbo(
  action: AdminAuditRecord["action"],
  actor: { uid: string; email?: string },
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await logAdminAudit({
      action,
      actingUid: actor.uid,
      actingEmail: actor.email,
      metadata,
    });
  } catch {
    // Audit must never break the operation it describes.
    logWarn("qbo.audit_failed", { action });
  }
}

// --- OAuth authorization request (connect / reconnect) ---

// Best-effort cleanup of states past their TTL. Bounded and non-blocking —
// correctness never depends on it since expiry is enforced at consume time.
async function cleanupExpiredOAuthStates(): Promise<void> {
  const db = getFirebaseAdminDb();
  const stale = await db
    .collection(QBO_OAUTH_STATES_COLLECTION)
    .where("expiresAt", "<", Timestamp.now())
    .limit(25)
    .get();
  if (stale.empty) return;
  const batch = db.batch();
  for (const docSnap of stale.docs) batch.delete(docSnap.ref);
  await batch.commit();
}

export interface QboAuthorizationRequest {
  authorizationUrl: string;
  state: string;
}

// Starts the OAuth flow for an authorized admin: generates a
// cryptographically-random state, persists it bound to the initiator and
// the configured environment, and returns the Intuit authorization URL.
// The state value itself doubles as the session cookie the callback
// cross-checks.
export async function createQboAuthorizationRequest(
  actor: AdminActor
): Promise<QboAuthorizationRequest> {
  const config = loadQboConfig();
  // Fail before issuing any state if the token envelope can't be written —
  // the callback would otherwise surface the same error only after the
  // admin completed Intuit consent.
  getQboEncryptionKey();
  const state = generateQboOAuthState();
  const now = Date.now();

  await getFirebaseAdminDb()
    .collection(QBO_OAUTH_STATES_COLLECTION)
    .doc(state)
    .set({
      uid: actor.token.uid,
      email: actor.token.email ?? actor.record.email,
      environment: config.environment,
      createdAt: Timestamp.fromMillis(now),
      expiresAt: Timestamp.fromMillis(now + QBO_OAUTH_STATE_TTL_MS),
    } satisfies QboOAuthStateDoc);

  void cleanupExpiredOAuthStates().catch(() => {});

  logInfo("qbo.oauth.started", { environment: config.environment });
  return {
    authorizationUrl: buildQboAuthorizationUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state,
    }),
    state,
  };
}

// --- OAuth callback ---

export type QboStateConsumption =
  | { verdict: "ok"; uid: string; email?: string }
  | { verdict: "missing" | "expired" | "consumed" | "environment_mismatch" };

// Consumes an authorization state atomically: it must exist, be unexpired,
// be unconsumed, and belong to the configured environment. The consumed
// marker stays so a replayed state reads as "consumed" rather than
// "missing" — the distinction matters for logs.
export async function consumeQboOAuthState(
  state: string
): Promise<QboStateConsumption> {
  const config = loadQboConfig();
  const ref = getFirebaseAdminDb()
    .collection(QBO_OAUTH_STATES_COLLECTION)
    .doc(state);

  return getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { verdict: "missing" as const };
    const data = snap.data() as QboOAuthStateDoc;
    const verdict = classifyQboOAuthState(
      {
        expiresAtMs: data.expiresAt.toMillis(),
        consumedAtMs: data.consumedAt?.toMillis() ?? null,
      },
      Date.now()
    );
    if (verdict !== "ok") return { verdict };
    if (data.environment !== config.environment) {
      return { verdict: "environment_mismatch" as const };
    }
    tx.update(ref, { consumedAt: Timestamp.now() });
    return { verdict: "ok" as const, uid: data.uid, email: data.email };
  });
}

// Completes the OAuth callback after the state has been consumed: exchanges
// the authorization code, proves the connection by reading CompanyInfo, and
// persists the encrypted connection. `realmId` comes from Intuit's redirect
// and identifies the company the admin selected.
export async function completeQboAuthorization(input: {
  code: string;
  realmId: string;
  uid: string;
  email?: string;
}): Promise<{ companyName: string }> {
  const config = loadQboConfig();
  const tokens = await requestQboTokens(
    buildQboTokenExchangeRequest({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code: input.code,
      redirectUri: config.redirectUri,
    }),
    "token exchange"
  );

  // Prove the grant works inside the authorized realm before recording
  // anything. The realm id Intuit sent on the OAuth callback is the
  // connected-company identity — CompanyInfo only confirms the read and
  // supplies display metadata, it can never re-assign the realm.
  const company = await fetchQboCompanyInfo({
    environment: config.environment,
    realmId: input.realmId,
    accessToken: tokens.accessToken,
  });

  const key = getQboEncryptionKey();
  const nowMs = Date.now();
  const now = Timestamp.fromMillis(nowMs);
  await qboConnectionRef(config.environment).set(
    {
      environment: config.environment,
      status: "connected",
      realmId: input.realmId,
      companyName: company.companyName,
      ...(company.country ? { companyCountry: company.country } : {}),
      accessTokenEnc: encryptQboSecret(tokens.accessToken, key),
      refreshTokenEnc: encryptQboSecret(tokens.refreshToken, key),
      accessTokenExpiresAt: Timestamp.fromMillis(
        nowMs + tokens.accessTokenExpiresInSec * 1000
      ),
      ...(tokens.refreshTokenExpiresInSec
        ? {
            refreshTokenExpiresAt: Timestamp.fromMillis(
              nowMs + tokens.refreshTokenExpiresInSec * 1000
            ),
          }
        : {}),
      connectedAt: now,
      connectedByUid: input.uid,
      ...(input.email ? { connectedByEmail: input.email } : {}),
      lastCheckAt: now,
      lastCheckStatus: "healthy",
      updatedAt: now,
      disconnectedAt: FieldValue.delete(),
      disconnectedByUid: FieldValue.delete(),
      refreshLeaseUntil: FieldValue.delete(),
    },
    { merge: true }
  );

  await auditQbo("qbo_connected", input, {
    environment: config.environment,
    companyName: company.companyName,
    realmIdShort: abbreviateRealmId(input.realmId),
  });
  logInfo("qbo.oauth.connected", {
    environment: config.environment,
    realmIdShort: abbreviateRealmId(input.realmId),
  });
  return { companyName: company.companyName };
}

// --- Admin status view ---

// Serialized connection view for the admin surface — metadata only, never
// token material.
export async function getQboAdminView(): Promise<QboAdminView> {
  let environment: QboEnvironment = "sandbox";
  try {
    environment = getQboEnvironment();
  } catch {
    // Unconfigured/invalid environment: report "not_configured" below.
  }
  const base = {
    environment,
    environmentLabel: qboEnvironmentLabel(environment),
  };
  if (!isQboConfigured()) {
    return {
      ...base,
      configured: false,
      status: "not_configured",
      health: "unknown",
      mappingConfigured: false,
    };
  }

  const snap = await qboConnectionRef(environment).get();
  const record = usableQboConnection(snap.data(), environment);
  if (
    !record ||
    record.status === "disconnected" ||
    !record.refreshTokenEnc
  ) {
    return {
      ...base,
      configured: true,
      status: "disconnected",
      health: "unknown",
      mappingConfigured: false,
    };
  }

  const mappingConfigured = await getQboMappingConfigured(
    environment,
    record.realmId
  );

  return {
    ...base,
    configured: true,
    status:
      record.status === "reauthorization_required"
        ? "reauthorization_required"
        : "connected",
    health: record.lastCheckStatus ?? "unknown",
    realmIdShort: record.realmId
      ? abbreviateRealmId(record.realmId)
      : undefined,
    companyName: record.companyName,
    companyCountry: record.companyCountry,
    connectedAt: toIsoString(record.connectedAt),
    connectedByEmail: record.connectedByEmail,
    lastCheckAt: toIsoString(record.lastCheckAt),
    mappingConfigured,
  };
}

// --- Connection health check ---

// Explicit admin-triggered health probe: refreshes the token if needed,
// calls CompanyInfo, and records the outcome. Returns the updated view —
// the check reports status rather than throwing, since an unhealthy result
// is the information the admin asked for.
export async function runQboConnectionCheck(
  actor: AdminActor
): Promise<QboAdminView> {
  const environment = getQboEnvironment();
  const view = await getQboAdminView();
  if (view.status !== "connected") {
    throw new QboError("QuickBooks is not connected.", "validation", 409);
  }

  const ref = qboConnectionRef(environment);
  try {
    const { accessToken, realmId } = await getQuickBooksAccessToken();
    const company = await fetchQboCompanyInfo({
      environment,
      realmId,
      accessToken,
    });
    await ref.update({
      lastCheckAt: Timestamp.now(),
      lastCheckStatus: "healthy",
      companyName: company.companyName,
      ...(company.country ? { companyCountry: company.country } : {}),
      updatedAt: Timestamp.now(),
    });
    await auditQbo("qbo_connection_checked", actor.token, {
      environment,
      outcome: "healthy",
    });
    logInfo("qbo.connection.checked", {
      environment,
      outcome: "healthy",
    });
  } catch (error) {
    const expired =
      error instanceof QboError && error.kind === "authorization_expired";
    const outcome: QboHealthStatus = expired
      ? "needs_reauthorization"
      : "provider_unavailable";
    await ref
      .update({
        lastCheckAt: Timestamp.now(),
        lastCheckStatus: outcome,
        updatedAt: Timestamp.now(),
      })
      .catch(() => {});
    await auditQbo("qbo_connection_checked", actor.token, {
      environment,
      outcome,
    });
    if (expired) {
      logWarn("qbo.connection.checked", { environment, outcome });
    } else {
      logError("qbo.connection.checked", error, { environment });
    }
  }
  return getQboAdminView();
}

// --- Disconnect ---

// Deliberate teardown: best-effort revoke of the refresh token at Intuit,
// then removal of all credential material. The realm/company identity and
// timestamps stay on the record as history — the audit log records the act.
// Historical sync/webhook records are never touched by a disconnect.
export async function disconnectQbo(actor: AdminActor): Promise<void> {
  const config = loadQboConfig();
  const ref = qboConnectionRef(config.environment);
  const snap = await ref.get();
  const record = usableQboConnection(snap.data(), config.environment);
  if (
    !record ||
    record.status === "disconnected" ||
    !record.refreshTokenEnc
  ) {
    throw new QboError("QuickBooks is not connected.", "validation", 409);
  }

  try {
    const refreshToken = decryptQboSecret(
      record.refreshTokenEnc,
      getQboEncryptionKey()
    );
    const request = buildQboRevokeRequest({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken,
    });
    const res = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
    });
    if (!res.ok) {
      logWarn("qbo.revoke_failed", {
        environment: config.environment,
        status: res.status,
      });
    }
  } catch {
    // Revocation is best-effort — credentials are destroyed locally either
    // way, and an expired/revoked grant can't be revoked again.
    logWarn("qbo.revoke_failed", { environment: config.environment });
  }

  await ref.update({
    status: "disconnected",
    disconnectedAt: Timestamp.now(),
    disconnectedByUid: actor.token.uid,
    accessTokenEnc: FieldValue.delete(),
    refreshTokenEnc: FieldValue.delete(),
    accessTokenExpiresAt: FieldValue.delete(),
    refreshTokenExpiresAt: FieldValue.delete(),
    refreshLeaseUntil: FieldValue.delete(),
    lastCheckAt: FieldValue.delete(),
    lastCheckStatus: FieldValue.delete(),
    updatedAt: Timestamp.now(),
  });
  await auditQbo("qbo_disconnected", actor.token, {
    environment: config.environment,
    realmIdShort: record.realmId
      ? abbreviateRealmId(record.realmId)
      : undefined,
  });
  logInfo("qbo.disconnected", { environment: config.environment });
}
