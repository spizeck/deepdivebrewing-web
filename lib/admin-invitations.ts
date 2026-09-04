import "server-only";
import { getFirebaseAdminDb } from "@/lib/firebase-admin";
import { normalizeEmail } from "@/lib/admin-common";
import type { AdminInvitation, AdminRole } from "@/lib/admin-types";
import { Timestamp } from "firebase-admin/firestore";

const COLLECTION = "adminInvitations";

export function getAdminInvitationsCollection() {
  return getFirebaseAdminDb().collection(COLLECTION);
}

export async function createInvitation(
  email: string,
  role: AdminRole,
  invitedByUid: string
): Promise<AdminInvitation> {
  const normalized = normalizeEmail(email);
  const ref = getAdminInvitationsCollection().doc();
  const data: Omit<AdminInvitation, "id"> = {
    email: normalized,
    role,
    status: "pending",
    invitedBy: invitedByUid,
    createdAt: Timestamp.now(),
  };
  await ref.set(data);
  return { id: ref.id, ...data };
}

export async function getPendingInvitationByEmail(
  email: string
): Promise<AdminInvitation | null> {
  const snapshot = await getAdminInvitationsCollection()
    .where("email", "==", normalizeEmail(email))
    .where("status", "==", "pending")
    .limit(1)
    .get();
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...(doc.data() as Omit<AdminInvitation, "id">) };
}

export async function listPendingInvitations(): Promise<AdminInvitation[]> {
  const snapshot = await getAdminInvitationsCollection()
    .where("status", "==", "pending")
    .orderBy("createdAt", "asc")
    .get();
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as Omit<AdminInvitation, "id">),
  }));
}

export async function markInvitationAccepted(
  invitationId: string,
  acceptedByUid: string
): Promise<void> {
  await getAdminInvitationsCollection().doc(invitationId).update({
    status: "accepted",
    acceptedAt: Timestamp.now(),
    acceptedBy: acceptedByUid,
  });
}

export async function cancelInvitation(invitationId: string): Promise<void> {
  await getAdminInvitationsCollection().doc(invitationId).update({
    status: "cancelled",
  });
}
