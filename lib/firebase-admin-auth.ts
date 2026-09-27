import "server-only";
import { getAuth } from "firebase-admin/auth";
import { getFirebaseAdminApp } from "@/lib/firebase-admin-app";

// Auth is isolated in its own module: only routes that actually verify
// tokens or manage users pay for the jwks-rsa -> jose dependency graph.
export function getFirebaseAdminAuth() {
  return getAuth(getFirebaseAdminApp());
}
