import "server-only";
import { getFirestore } from "firebase-admin/firestore";
import { getFirebaseAdminApp } from "@/lib/firebase-admin-app";

// Firestore lives in its own module so Firestore-only routes never import
// firebase-admin/auth — its jwks-rsa -> ESM-only jose chain is the failure
// that caused the nfl-picks Vercel runtime outage (ERR_REQUIRE_ESM despite
// a clean build).
export function getFirebaseAdminDb() {
  return getFirestore(getFirebaseAdminApp());
}
