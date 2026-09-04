import "server-only";
import { getFirebaseAdminDb } from "@/lib/firebase-admin";
import {
  buildExistingAdminLoginUpdate,
  buildNewAdminUserRecord,
} from "@/lib/admin-users-common";
import type { AdminRole, AdminUserRecord } from "@/lib/admin-types";
import { Timestamp } from "firebase-admin/firestore";

const COLLECTION = "adminUsers";

export function getAdminUsersCollection() {
  return getFirebaseAdminDb().collection(COLLECTION);
}

export async function getAdminUser(uid: string): Promise<AdminUserRecord | null> {
  const doc = await getAdminUsersCollection().doc(uid).get();
  if (!doc.exists) return null;
  return { uid: doc.id, ...(doc.data() as Omit<AdminUserRecord, "uid">) };
}

export async function listAdminUsers(): Promise<AdminUserRecord[]> {
  const snapshot = await getAdminUsersCollection().orderBy("createdAt", "asc").get();
  return snapshot.docs.map((doc) => ({
    uid: doc.id,
    ...(doc.data() as Omit<AdminUserRecord, "uid">),
  }));
}

export async function ensureAdminUser(
  uid: string,
  email: string,
  role: AdminRole,
  actorUid: string,
  displayName?: string
): Promise<AdminUserRecord> {
  const ref = getAdminUsersCollection().doc(uid);
  const existing = await ref.get();
  const now = Timestamp.now();

  if (!existing.exists) {
    const record = buildNewAdminUserRecord(email, role, actorUid, now, displayName);
    await ref.set(record);
    return { uid, ...record };
  }

  const existingData = existing.data() as Partial<AdminUserRecord> | undefined;
  await ref.update(buildExistingAdminLoginUpdate(existingData, actorUid, now, displayName));
  return getAdminUser(uid) as Promise<AdminUserRecord>;
}

export async function updateAdminUser(
  uid: string,
  updates: Partial<Pick<AdminUserRecord, "displayName" | "role" | "status">>,
  actorUid: string
): Promise<void> {
  const ref = getAdminUsersCollection().doc(uid);
  const now = Timestamp.now();
  const payload: Record<string, unknown> = {
    updatedAt: now,
    updatedBy: actorUid,
  };

  if (updates.role !== undefined) {
    payload.role = updates.role;
  }
  if (updates.status !== undefined) {
    payload.status = updates.status;
  }
  if (updates.displayName !== undefined) {
    const trimmed = updates.displayName.trim();
    if (trimmed) {
      payload.displayName = trimmed;
    } else {
      payload.displayName = "";
    }
  }

  await ref.update(payload);
}

export async function countActiveSuperAdmins(): Promise<number> {
  const snapshot = await getAdminUsersCollection()
    .where("role", "==", "superadmin")
    .where("status", "==", "active")
    .count()
    .get();
  return snapshot.data().count;
}
