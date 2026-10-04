import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { logAdminAudit } from "@/lib/admin-audit";
import type { AdminActor } from "@/lib/admin-auth";
import { toIsoString } from "@/lib/admin-serializers";
import { getQuickBooksAccessToken } from "@/lib/qbo-tokens";
import { queryQboEntities } from "@/lib/qbo-api";
import { getQboEnvironment } from "@/lib/qbo-config";
import { QboError } from "@/lib/qbo-errors";
import { logWarn } from "@/lib/log";
import {
  QBO_ACCOUNTING_MAPPING_DOC,
  QBO_CONFIG_COLLECTION,
  QBO_CONNECTIONS_COLLECTION,
  type QboAccountingMapping,
  type QboAccountingMappingView,
  type QboDiscoveryEntityType,
  type QboEnvironment,
} from "@/lib/qbo-common";

// Future accounting-mapping configuration (issue #161). The mapping records
// which QBO entities (Account/Item/Customer/TaxCode) later Stripe/tour
// revenue should post against — selected from live entities of the
// *connected* company, never hard-coded. Until configured, the admin
// surface reports "Accounting mapping not configured".
//
// The document is bound to an environment AND a realmId: a stale mapping
// from a different company or a different QBO_ENVIRONMENT is never applied.

interface QboMappingDoc extends QboAccountingMapping {
  environment: QboEnvironment;
  realmId: string;
  entityNames?: Record<string, string>;
  updatedAt?: Timestamp;
  updatedByUid?: string;
}

function mappingRef() {
  return getFirebaseAdminDb()
    .collection(QBO_CONFIG_COLLECTION)
    .doc(QBO_ACCOUNTING_MAPPING_DOC);
}

async function connectedRealmId(
  environment: QboEnvironment
): Promise<string | null> {
  const snap = await getFirebaseAdminDb()
    .collection(QBO_CONNECTIONS_COLLECTION)
    .doc(environment)
    .get();
  const data = snap.data();
  if (
    !data ||
    data.environment !== environment ||
    data.status !== "connected" ||
    typeof data.realmId !== "string" ||
    !data.realmId
  ) {
    return null;
  }
  return data.realmId;
}

// Whether a usable mapping exists for the live connection — used by the
// admin status view. Reads the connection doc itself so this module has no
// import dependency on lib/qbo.ts view code.
export async function getQboMappingConfigured(
  environment: QboEnvironment,
  realmId?: string
): Promise<boolean> {
  const snap = await mappingRef().get();
  const data = snap.data() as QboMappingDoc | undefined;
  if (!data || data.environment !== environment) return false;
  return Boolean(realmId && data.realmId === realmId);
}

export async function getQboMappingView(): Promise<QboAccountingMappingView> {
  const environment = getQboEnvironment();
  const realmId = await connectedRealmId(environment);
  const snap = await mappingRef().get();
  const data = snap.data() as QboMappingDoc | undefined;
  if (!data || data.environment !== environment || !realmId || data.realmId !== realmId) {
    return { configured: false };
  }
  const mapping: QboAccountingMapping = {};
  for (const { key } of MAPPING_FIELDS) {
    const value = data[key];
    if (value) mapping[key] = value;
  }
  return {
    configured: true,
    mapping,
    entityNames: data.entityNames,
    updatedAt: toIsoString(data.updatedAt),
  };
}

const MAPPING_FIELDS: Array<{
  key: keyof QboAccountingMapping;
  entityType: QboDiscoveryEntityType;
}> = [
  { key: "stripeClearingAccountId", entityType: "account" },
  { key: "tourIncomeItemId", entityType: "item" },
  { key: "tastingIncomeItemId", entityType: "item" },
  { key: "otherIncomeItemId", entityType: "item" },
  { key: "fallbackCustomerId", entityType: "customer" },
  { key: "taxCodeId", entityType: "tax-code" },
];

const QBO_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Saves the admin's entity selections after validating every id against a
// live entity query — a typo or stale id can never be persisted as the
// accounting target. Display names resolved from the same query are stored
// so the admin view doesn't need a second lookup.
export async function saveQboMapping(
  actor: AdminActor,
  input: unknown
): Promise<QboAccountingMappingView> {
  const environment = getQboEnvironment();
  const realmId = await connectedRealmId(environment);
  if (!realmId) {
    throw new QboError(
      "QuickBooks must be connected before accounting mapping can be configured.",
      "validation",
      409
    );
  }

  if (typeof input !== "object" || input === null) {
    throw new QboError("Invalid mapping payload.", "validation", 400);
  }
  const raw = input as Record<string, unknown>;
  const mapping: QboAccountingMapping = {};
  for (const { key } of MAPPING_FIELDS) {
    const value = raw[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !QBO_ID_PATTERN.test(value)) {
      throw new QboError(`Invalid QuickBooks id for ${key}.`, "validation", 400);
    }
    mapping[key] = value;
  }

  // Resolve every referenced entity type once, then validate membership.
  const { accessToken } = await getQuickBooksAccessToken();
  const typesNeeded = new Set(
    MAPPING_FIELDS.filter(({ key }) => mapping[key]).map(
      ({ entityType }) => entityType
    )
  );
  const entityNames: Record<string, string> = {};
  for (const type of typesNeeded) {
    const entities = await queryQboEntities({
      environment,
      realmId,
      accessToken,
      type,
    });
    const byId = new Map(entities.map((e) => [e.id, e.name]));
    for (const { key, entityType } of MAPPING_FIELDS) {
      const id = mapping[key];
      if (entityType !== type || !id) continue;
      const name = byId.get(id);
      if (name === undefined) {
        throw new QboError(
          `The selected ${key} does not exist in the connected QuickBooks company.`,
          "validation",
          400
        );
      }
      entityNames[id] = name;
    }
  }

  await mappingRef().set({
    ...mapping,
    environment,
    realmId,
    entityNames,
    updatedAt: Timestamp.now(),
    updatedByUid: actor.token.uid,
  } satisfies QboMappingDoc);

  try {
    await logAdminAudit({
      action: "qbo_mapping_updated",
      actingUid: actor.token.uid,
      actingEmail: actor.token.email ?? actor.record.email,
      metadata: { environment, fields: Object.keys(mapping) },
    });
  } catch {
    logWarn("qbo.audit_failed", { action: "qbo_mapping_updated" });
  }

  return getQboMappingView();
}
