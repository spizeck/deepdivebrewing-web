import "server-only";
import { getFirebaseAdminDb } from "@/lib/firebase-admin";
import { normalizeEmail } from "@/lib/admin-common";
import type { AdminRole, AdminStatus } from "@/lib/types";
import { Timestamp } from "firebase-admin/firestore";

export interface AdminUserRecord {
  uid: string;
  email: string;
  displayName?: string;
  role: AdminRole;
  status: AdminStatus;
  createdAt: FirebaseFirestore.Timestamp;
  createdBy?: string;
  updatedAt?: FirebaseFirestore.Timestamp;
  updatedBy?: string;
  lastLoginAt?: FirebaseFirestore.Timestamp;
}

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
    const record: Omit<AdminUserRecord, "uid"> = {
      email: normalizeEmail(email),
      displayName,
      role,
      status: "active",
      createdAt: now,
      createdBy: actorUid,
      updatedAt: now,
      updatedBy: actorUid,
      lastLoginAt: now,
    };
    await ref.set(record);
    return { uid, ...record };
  }
  await ref.update({
    lastLoginAt: now,
    updatedAt: now,
    updatedBy: actorUid,
  });
  return getAdminUser(uid) as Promise<AdminUserRecord>;
}

export async function updateAdminUser(
  uid: string,
  updates: Partial<Pick<AdminUserRecord, "displayName" | "role" | "status">>,
  actorUid: string
): Promise<void> {
  const ref = getAdminUsersCollection().doc(uid);
  const now = Timestamp.now();
  await ref.update({
    ...updates,
    updatedAt: now,
    updatedBy: actorUid,
  });
}

export async function countActiveSuperAdmins(): Promise<number> {
  const snapshot = await getAdminUsersCollection()
    .where("role", "==", "superadmin")
    .where("status", "==", "active")
    .count()
    .get();
  return snapshot.data().count;
}
