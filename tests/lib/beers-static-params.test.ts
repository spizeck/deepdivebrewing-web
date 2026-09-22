import { after, describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { deleteApp, getApps } from "firebase/app";
import { terminate } from "firebase/firestore";
import { getFirebaseDb, hasFirebaseConfig } from "@/lib/firebase";

// The configured-path test initializes a real Firestore client whose gRPC
// streams would otherwise keep the test process alive after completion.
after(async () => {
  if (getApps().length === 0) return;
  await terminate(getFirebaseDb());
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

const FIREBASE_ENV_KEYS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

async function withEnv<T>(
  values: Record<string, string | undefined>,
  fn: () => Promise<T> | T
): Promise<T> {
  const originals = FIREBASE_ENV_KEYS.map((k) => process.env[k]);
  for (const k of FIREBASE_ENV_KEYS) delete process.env[k];
  Object.assign(
    process.env,
    Object.fromEntries(
      Object.entries(values).filter(([, v]) => v !== undefined)
    )
  );
  try {
    return await fn();
  } finally {
    FIREBASE_ENV_KEYS.forEach((k, i) => {
      if (originals[i] === undefined) delete process.env[k];
      else process.env[k] = originals[i];
    });
  }
}

describe("hasFirebaseConfig", () => {
  it("is false when the public config is absent", async () => {
    await withEnv({}, () => assert.equal(hasFirebaseConfig(), false));
  });

  it("is true when the public config is present", async () => {
    await withEnv(
      {
        NEXT_PUBLIC_FIREBASE_API_KEY: "key",
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: "project",
        NEXT_PUBLIC_FIREBASE_APP_ID: "app",
      },
      () => assert.equal(hasFirebaseConfig(), true)
    );
  });
});

describe("getBeerStaticParams", () => {
  it("returns [] without initializing Firebase when unconfigured", async () => {
    // Credential-free builds (CI, local without .env.local) intentionally
    // produce no beer pages. Returning early also avoids the SDK's noisy
    // offline-fallback errors during `next build`.
    const { getBeerStaticParams } = await import("@/lib/beers");
    const params = await withEnv({}, () => getBeerStaticParams());
    assert.deepEqual(params, []);
  });

  it("rejects when configured but Firestore cannot be enumerated", async () => {
    // A syntactically valid config pointing at a nonexistent project makes
    // getDocsFromServer throw `unavailable` — the same failure class as a
    // network outage or permission denial. Letting it reject (rather than
    // swallowing to []) is what prevents a bad build from deploying zero
    // beer pages.
    const { getBeerStaticParams } = await import("@/lib/beers");
    await withEnv(
      {
        NEXT_PUBLIC_FIREBASE_API_KEY: "ci-dummy-api-key",
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: "nonexistent-proj-xq9",
        NEXT_PUBLIC_FIREBASE_APP_ID: "1:0:web:x",
      },
      () =>
        assert.rejects(
          getBeerStaticParams(),
          (e: unknown) => (e as { code?: string }).code === "unavailable"
        )
    );
  });
});

describe("beer static-params source guards", () => {
  const beersSource = fs.readFileSync(
    path.join(process.cwd(), "lib", "beers.ts"),
    "utf8"
  );
  const pageSource = fs.readFileSync(
    path.join(process.cwd(), "app", "(pages)", "beers", "[slug]", "page.tsx"),
    "utf8"
  );

  it("enumerates via getDocsFromServer, never the cache-fallback getDocs", () => {
    const fn = beersSource.slice(beersSource.indexOf("getBeerStaticParams"));
    assert.ok(fn.includes("getDocsFromServer(publicBeersQuery())"));
    assert.ok(!fn.includes("getDocs("));
  });

  it("returns params in the { slug } shape Next expects", () => {
    assert.ok(
      beersSource.includes("snapshot.docs.map((doc) => ({ slug:") ||
        beersSource.includes("{ slug: (doc.data()")
    );
  });

  it("page disables dynamic params and delegates to the canonical service", () => {
    assert.ok(pageSource.includes("export const dynamicParams = false"));
    assert.ok(pageSource.includes("getBeerStaticParams()"));
    assert.ok(!pageSource.includes("firebase/firestore"));
    assert.ok(!pageSource.includes("collection("));
  });
});
