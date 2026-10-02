import "server-only";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { getAdminUser, listAdminUsers } from "@/lib/admin-users";
import { TRADE_LEADS_COLLECTION } from "@/lib/trade-leads-common";
import {
  buildLeadUpdate,
  DELETE_FIELD,
  TRADE_LEAD_ACTIVITIES_SUBCOLLECTION,
  TradeLeadError,
  TradeLeadNotFoundError,
  type ManualTradeLeadInput,
  type NormalizedLeadPatch,
  type TradeLeadAssignee,
} from "@/lib/trade-leads-admin-common";

// Identity the activity timeline records. `name` is a stable display string
// (displayName, falling back to email) snapshotted at write time so history
// stays readable even if an admin record later changes.
export interface TradeLeadActor {
  uid: string;
  name: string;
}

// Builds the timeline identity for an authenticated AdminActor: prefer the
// adminUsers record's displayName, then the token's name/email.
export function tradeLeadActorOf(actor: {
  token: { uid: string; name?: string; email?: string };
  record: { displayName?: string; email: string };
}): TradeLeadActor {
  return {
    uid: actor.token.uid,
    name:
      actor.record.displayName?.trim() ||
      actor.token.name?.trim() ||
      actor.token.email?.trim() ||
      actor.record.email,
  };
}

// Admin SDK reads — never imported by client components. `tradeLeads` is
// deny-all in firestore.rules; these functions are the only read/write
// surface and are always called behind requireAdminActor.

export function getTradeLeadsCollection() {
  return getFirebaseAdminDb().collection(TRADE_LEADS_COLLECTION);
}

export async function listTradeLeads(): Promise<
  { id: string; data: Record<string, unknown> }[]
> {
  // Single-field ordering only — no composite index needed; filters and
  // secondary sorts run client-side over the returned list (lead volume is
  // modest for a single brewery).
  const snapshot = await getTradeLeadsCollection()
    .orderBy("createdAt", "desc")
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
}

export async function getTradeLead(
  id: string
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const doc = await getTradeLeadsCollection().doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, data: doc.data() ?? {} };
}

export async function listTradeLeadActivities(
  leadId: string
): Promise<{ id: string; data: Record<string, unknown> }[]> {
  // `seq` is a per-lead monotonically increasing counter assigned inside the
  // same transaction as the write, so ordering is deterministic even when
  // several entries share a server timestamp.
  const snapshot = await getTradeLeadsCollection()
    .doc(leadId)
    .collection(TRADE_LEAD_ACTIVITIES_SUBCOLLECTION)
    .orderBy("seq", "asc")
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
}

// Leads may only be assigned to active administrators — the same identity
// pool as the rest of the admin app, no separate CRM user table.
export async function listAssignableAdmins(): Promise<TradeLeadAssignee[]> {
  const users = await listAdminUsers();
  return users
    .filter((user) => user.status === "active")
    .map((user) => ({
      uid: user.uid,
      name: user.displayName?.trim() || user.email,
    }));
}

// Resolves a client-supplied uid to a verified active admin. Throws a
// client-safe error when the uid is not an active administrator.
export async function resolveAssignee(uid: string): Promise<TradeLeadAssignee> {
  const record = await getAdminUser(uid);
  if (!record || record.status !== "active") {
    throw new TradeLeadError(
      "Selected owner is not an active administrator.",
      400
    );
  }
  return {
    uid: record.uid,
    name: record.displayName?.trim() || record.email,
  };
}

// Translates the pure update plan into Firestore terms: Date → Timestamp,
// DELETE_FIELD → FieldValue.delete().
function translateUpdates(
  updates: Record<string, unknown>
): Record<string, unknown> {
  const translated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === DELETE_FIELD) {
      translated[key] = FieldValue.delete();
    } else if (value instanceof Date) {
      translated[key] = Timestamp.fromDate(value);
    } else {
      translated[key] = value;
    }
  }
  return translated;
}

function activityDoc(
  draft: { type: string; body?: string; details?: Record<string, string | null> },
  seq: number,
  actor: TradeLeadActor | null
) {
  return {
    type: draft.type,
    seq,
    ...(draft.body ? { body: draft.body } : {}),
    ...(draft.details ? { details: draft.details } : {}),
    // Web-submitted creation entries have no admin author.
    ...(actor ? { authorUid: actor.uid, authorName: actor.name } : {}),
    createdAt: FieldValue.serverTimestamp(),
  };
}

// Records a lead an admin took down by hand (WhatsApp, phone, walk-in, …).
// Manual leads enter the same pipeline as web submissions: status "new",
// with a `lead_created` activity so the timeline is never empty.
export async function createManualTradeLead(
  input: ManualTradeLeadInput,
  actor: TradeLeadActor
): Promise<string> {
  const db = getFirebaseAdminDb();
  const leadRef = db.collection(TRADE_LEADS_COLLECTION).doc();
  const activityRef = leadRef
    .collection(TRADE_LEAD_ACTIVITIES_SUBCOLLECTION)
    .doc();

  const batch = db.batch();
  batch.set(leadRef, {
    businessName: input.businessName,
    contactName: input.contactName,
    email: input.email,
    phoneOrWhatsapp: input.phoneOrWhatsapp,
    venueType: input.venueType,
    message: input.message,
    status: "new",
    source: input.source,
    activityCount: 1,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastActivityAt: FieldValue.serverTimestamp(),
  });
  batch.set(
    activityRef,
    activityDoc(
      { type: "lead_created", details: { source: input.source } },
      0,
      actor
    )
  );
  await batch.commit();
  return leadRef.id;
}

export interface LeadPatchResult {
  changed: boolean;
  activityTypes: string[];
}

// Applies a validated patch inside a transaction: the update plan is built
// from the fresh record so concurrent edits can't silently drop an
// intermediate change, and every produced activity gets a `seq` continuing
// the lead's `activityCount`.
export async function applyLeadPatch(
  leadId: string,
  patch: NormalizedLeadPatch,
  actor: TradeLeadActor
): Promise<LeadPatchResult> {
  const ref = getTradeLeadsCollection().doc(leadId);
  const now = new Date();

  return getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new TradeLeadNotFoundError();

    const outcome = buildLeadUpdate(
      (snap.data() ?? {}) as Parameters<typeof buildLeadUpdate>[0],
      patch,
      now
    );
    if (!outcome.ok) throw new TradeLeadError(outcome.error, 400);
    const { plan } = outcome;
    if (!plan.changed) return { changed: false, activityTypes: [] };

    const base =
      typeof snap.data()?.activityCount === "number"
        ? (snap.data()!.activityCount as number)
        : 0;
    const updates = translateUpdates(plan.updates);
    updates.activityCount = base + plan.activities.length;
    tx.update(ref, updates);

    plan.activities.forEach((draft, index) => {
      tx.set(
        ref.collection(TRADE_LEAD_ACTIVITIES_SUBCOLLECTION).doc(),
        activityDoc(draft, base + index, actor)
      );
    });

    return {
      changed: true,
      activityTypes: plan.activities.map((a) => a.type),
    };
  });
}

// Appends an internal note and marks it as meaningful activity (the lead's
// `updatedAt`/`lastActivityAt` advance — that is what extends the retention
// window). Notes are never edited or overwritten.
export async function addTradeLeadNote(
  leadId: string,
  note: string,
  actor: TradeLeadActor
): Promise<void> {
  const ref = getTradeLeadsCollection().doc(leadId);

  await getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new TradeLeadNotFoundError();
    const base =
      typeof snap.data()?.activityCount === "number"
        ? (snap.data()!.activityCount as number)
        : 0;

    tx.set(
      ref.collection(TRADE_LEAD_ACTIVITIES_SUBCOLLECTION).doc(),
      activityDoc({ type: "note", body: note }, base, actor)
    );
    tx.update(ref, {
      activityCount: base + 1,
      updatedAt: FieldValue.serverTimestamp(),
      lastActivityAt: FieldValue.serverTimestamp(),
    });
  });
}
