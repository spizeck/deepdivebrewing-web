// Diagnostic: how does the Firebase client SDK behave for build-time reads?
// Run: node --import tsx --env-file=.env.local scripts/diagnose-firestore-build-reads.ts
import { initializeApp, deleteApp } from "firebase/app";
import {
  getFirestore,
  collection,
  getDocs,
  getDocsFromServer,
  getDocsFromCache,
  query,
  where,
  orderBy,
  disableNetwork,
} from "firebase/firestore";

const realConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

async function probe(label: string, fn: () => Promise<unknown>) {
  const t0 = Date.now();
  try {
    const snap = (await fn()) as {
      empty: boolean;
      size: number;
      metadata: { fromCache: boolean; hasPendingWrites: boolean };
    };
    console.log(
      `${label}: OK empty=${snap.empty} size=${snap.size} fromCache=${snap.metadata.fromCache} pending=${snap.metadata.hasPendingWrites} (${Date.now() - t0}ms)`
    );
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.log(
      `${label}: THROW code=${err.code} msg=${String(err.message).slice(0, 120)} (${Date.now() - t0}ms)`
    );
  }
}

async function main() {
  // Case A: real config, real catalog query (getDocs)
  {
    const app = initializeApp(realConfig, "a");
    const db = getFirestore(app);
    const q = query(
      collection(db, "beers"),
      where("isPublic", "==", true),
      orderBy("sortOrder", "asc")
    );
    await probe("A. real config + real query + getDocs", () => getDocs(q));
    await probe("A2. real config + real query + getDocsFromServer", () =>
      getDocsFromServer(q)
    );
    await probe("A3. real config + real query + getDocsFromCache", () =>
      getDocsFromCache(q)
    );
    // Empty-success: query guaranteed to match nothing
    const qEmpty = query(
      collection(db, "beers"),
      where("isPublic", "==", true),
      where("slug", "==", "___no_such_slug___")
    );
    await probe("A4. real config + empty-match query + getDocs", () =>
      getDocs(qEmpty)
    );
    await probe("A5. real config + empty-match query + getDocsFromServer", () =>
      getDocsFromServer(qEmpty)
    );
    // Offline simulation: disable network, then read
    await disableNetwork(db);
    await probe("A6. network disabled + getDocs", () => getDocs(q));
    await probe("A7. network disabled + getDocsFromServer", () =>
      getDocsFromServer(q)
    );
    await deleteApp(app);
  }

  // Case B: invalid project (syntactically valid config, nonexistent project)
  {
    const app = initializeApp(
      { ...realConfig, projectId: "nonexistent-proj-xq9" },
      "b"
    );
    const db = getFirestore(app);
    const q = query(collection(db, "beers"), where("isPublic", "==", true));
    await probe("B. invalid project + getDocs", () => getDocs(q));
    await probe("B2. invalid project + getDocsFromServer", () =>
      getDocsFromServer(q)
    );
    await deleteApp(app);
  }

  // Case C: garbage apiKey / undefined fields (partial config)
  {
    const app = initializeApp(
      { ...realConfig, apiKey: "totally-invalid-key" },
      "c"
    );
    const db = getFirestore(app);
    const q = query(collection(db, "beers"), where("isPublic", "==", true));
    await probe("C. invalid apiKey + getDocs", () => getDocs(q));
    await deleteApp(app);
  }

  // Case D: completely undefined config (CI simulation)
  {
    const app = initializeApp(
      {
        apiKey: undefined,
        authDomain: undefined,
        projectId: undefined,
      } as never,
      "d"
    );
    try {
      const db = getFirestore(app);
      const q = query(collection(db, "beers"), where("isPublic", "==", true));
      await probe("D. no config + getDocs", () => getDocs(q));
      await probe("D2. no config + getDocsFromServer", () =>
        getDocsFromServer(q)
      );
    } catch (e) {
      console.log(`D init: THROW ${(e as Error).message.slice(0, 120)}`);
    }
    await deleteApp(app);
  }
}

main().then(() => process.exit(0));
