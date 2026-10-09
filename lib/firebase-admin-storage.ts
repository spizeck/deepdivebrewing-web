import "server-only";
import { getStorage } from "firebase-admin/storage";
import { getFirebaseAdminApp } from "@/lib/firebase-admin-app";

// Admin SDK Storage accessor, split from firebase-admin-db.ts for the same
// reason that module exists: routes that only need Firestore should not
// evaluate the Storage graph (or vice versa).
export function getFirebaseAdminBucket() {
  const bucketName = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  const storage = getStorage(getFirebaseAdminApp());
  return bucketName ? storage.bucket(bucketName) : storage.bucket();
}
