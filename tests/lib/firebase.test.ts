import { describe, it } from "node:test";
import assert from "node:assert";
import { getApps } from "firebase/app";

const PUBLIC_ENV = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "ci-dummy-api-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "ci-dummy.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "ci-dummy-project",
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "ci-dummy.appspot.com",
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "000000000000",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:000000000000:web:cidummy",
  NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: "G-CIDUMMY123",
};

describe("firebase client initialization", () => {
  it("does not initialize an app at module import", async () => {
    // Each test file runs in its own process, so a zero app count here proves
    // importing lib/firebase performs no eager initializeApp/service calls.
    await import("@/lib/firebase");
    assert.equal(getApps().length, 0);
  });

  it("initializes lazily on first use and caches the app", async () => {
    const originals = Object.fromEntries(
      Object.keys(PUBLIC_ENV).map((k) => [k, process.env[k]])
    );
    Object.assign(process.env, PUBLIC_ENV);
    try {
      const {
        getFirebaseApp,
        getFirebaseDb,
        getFirebaseAuth,
        getFirebaseStorage,
      } = await import("@/lib/firebase");
      const app = getFirebaseApp();
      assert.equal(getApps().length, 1);
      assert.equal(getFirebaseApp(), app);
      assert.equal(getFirebaseDb(), getFirebaseDb());
      assert.equal(getFirebaseAuth(), getFirebaseAuth());
      assert.equal(getFirebaseStorage(), getFirebaseStorage());
    } finally {
      for (const [key, value] of Object.entries(originals)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
