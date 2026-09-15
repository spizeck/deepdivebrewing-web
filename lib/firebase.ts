import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getAuth, type Auth } from "firebase/auth";
import { getStorage, type FirebaseStorage } from "firebase/storage";

// Lazy accessors: importing this module must not read or construct Firebase
// configuration or services, so build-time module evaluation never requires
// NEXT_PUBLIC_FIREBASE_* values. In the browser these are inlined by the
// bundler; the SDK validates them when a service is first used.
function getFirebaseConfig() {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
  };
}

let app: FirebaseApp | undefined;
let dbInstance: Firestore | undefined;
let authInstance: Auth | undefined;
let storageInstance: FirebaseStorage | undefined;

export function getFirebaseApp(): FirebaseApp {
  if (!app) {
    app =
      getApps().length === 0 ? initializeApp(getFirebaseConfig()) : getApps()[0];
  }
  return app;
}

export function getFirebaseDb(): Firestore {
  dbInstance ??= getFirestore(getFirebaseApp());
  return dbInstance;
}

export function getFirebaseAuth(): Auth {
  authInstance ??= getAuth(getFirebaseApp());
  return authInstance;
}

export function getFirebaseStorage(): FirebaseStorage {
  storageInstance ??= getStorage(getFirebaseApp());
  return storageInstance;
}
