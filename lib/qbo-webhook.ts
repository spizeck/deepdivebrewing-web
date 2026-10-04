import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { getQboEnvironment, getQboWebhookVerifierToken } from "@/lib/qbo-config";
import { QboConfigError, QboError } from "@/lib/qbo-errors";
import { logWarn } from "@/lib/log";
import {
  parseQboWebhookNotifications,
  qboWebhookDedupeKey,
  verifyQboWebhookSignature,
} from "@/lib/qbo-protocol";
import {
  QBO_CONNECTIONS_COLLECTION,
  QBO_WEBHOOK_RECEIPTS_COLLECTION,
} from "@/lib/qbo-common";

// QuickBooks webhook receiver internals (issue #161). The route is
// unauthenticated in the HTTP sense — the caller is Intuit — so the
// `intuit-signature` HMAC-SHA256 over the raw body is the entire trust
// boundary, verified before any payload field is read.
//
// This is the foundation only: verified notifications are recorded as
// durable dedupe receipts. No entity synchronization runs yet — the future
// accounting sync consumes these (or re-queries QBO) once the bookkeeping
// policy is chosen.

export interface QboWebhookOutcome {
  /** Notifications parsed from the body. */
  received: number;
  /** Notifications persisted as new receipts. */
  recorded: number;
  /** Notifications that replayed an existing receipt. */
  duplicates: number;
  /** Receipts for a realm other than the connected company. */
  ignoredRealms: number;
}

// Verifies the signature and parses notifications. Throws client-safe
// QboError for an unconfigured secret or a bad signature — the route maps
// both to refusals without touching state.
export function verifyQboWebhookRequest(
  rawBody: string,
  signatureHeader: string | null
): ReturnType<typeof parseQboWebhookNotifications> {
  const verifier = getQboWebhookVerifierToken();
  if (!verifier) {
    throw new QboConfigError(
      "QBO_WEBHOOK_VERIFIER_TOKEN is not configured."
    );
  }
  if (!verifyQboWebhookSignature(rawBody, signatureHeader, verifier)) {
    throw new QboError("Invalid webhook signature.", "validation", 401);
  }
  return parseQboWebhookNotifications(rawBody);
}

// Persists each notification exactly once. The dedupe key is a hash of the
// notification's content identity (realm + entity + operation + timestamp)
// — a replayed delivery hashes identically and lands on the existing
// receipt inside the same transaction semantics that guard the trade-lead
// and webhook code paths.
export async function recordQboWebhookNotifications(
  notifications: ReturnType<typeof parseQboWebhookNotifications>,
  requestId: string
): Promise<QboWebhookOutcome> {
  const outcome: QboWebhookOutcome = {
    received: notifications.length,
    recorded: 0,
    duplicates: 0,
    ignoredRealms: 0,
  };
  if (notifications.length === 0) return outcome;

  // Realm recognition: notifications for a company we are not connected to
  // are recorded (for dedupe) but flagged ignored — they must never trigger
  // future sync work.
  let connectedRealmId: string | null = null;
  try {
    const environment = getQboEnvironment();
    const snap = await getFirebaseAdminDb()
      .collection(QBO_CONNECTIONS_COLLECTION)
      .doc(environment)
      .get();
    const data = snap.data();
    if (
      data &&
      data.environment === environment &&
      typeof data.realmId === "string" &&
      data.realmId
    ) {
      connectedRealmId = data.realmId;
    }
  } catch {
    logWarn("qbo.webhook.realm_lookup_failed", { requestId });
  }

  const db = getFirebaseAdminDb();
  const receipts = db.collection(QBO_WEBHOOK_RECEIPTS_COLLECTION);
  for (const notification of notifications) {
    const realmKnown =
      connectedRealmId !== null && notification.realmId === connectedRealmId;
    const receiptRef = receipts.doc(qboWebhookDedupeKey(notification));
    const result = await db.runTransaction(async (tx) => {
      const existing = await tx.get(receiptRef);
      if (existing.exists) return "duplicate" as const;
      tx.create(receiptRef, {
        realmId: notification.realmId,
        entityName: notification.entityName,
        entityId: notification.entityId,
        operation: notification.operation,
        lastUpdated: notification.lastUpdated,
        realmKnown,
        receivedAt: FieldValue.serverTimestamp(),
        requestId,
      });
      return "recorded" as const;
    });
    if (result === "duplicate") {
      outcome.duplicates++;
      continue;
    }
    outcome.recorded++;
    if (!realmKnown) outcome.ignoredRealms++;
  }
  return outcome;
}
