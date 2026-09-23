import { after, describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { deleteApp, getApps } from "firebase/app";
import { terminate } from "firebase/firestore";
import { getFirebaseDb, hasFirebaseConfig } from "@/lib/firebase";

// The configured-path tests initialize a real Firestore client whose gRPC
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

// A syntactically valid config pointing at a nonexistent project.
const CONFIGURED_ENV = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "ci-dummy-api-key",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "nonexistent-proj-xq9",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:0:web:x",
} as const;

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

// Credential-free builds (CI, local without .env.local) intentionally
// produce empty content. The helper must return the documented fallback
// without initializing Firebase or issuing a read — an initialized app
// would register in getApps(), and a Firestore read cannot happen without
// one. Returning early also avoids the SDK's noisy offline-fallback
// errors during `next build`.
//
// The zero-app baseline is strict: these tests must precede the
// configured-failure tests, which initialize a real Firestore client for
// the rest of the process. node:test runs tests sequentially in
// declaration order.
async function assertUnconfiguredFallback<T>(
  fn: () => Promise<T>,
  expected: T
): Promise<void> {
  const result = await withEnv({}, fn);
  assert.deepEqual(result, expected);
  assert.equal(getApps().length, 0);
}

// A configured but unreachable Firestore makes `getDocsFromServer` reject
// (`unavailable` — the same failure class as a network outage or
// permission denial). Letting helpers reject rather than swallow to
// []/null is what prevents a bad build from deploying empty content or
// false beer 404s. Plain `getDocs` would instead resolve from the empty
// offline cache, so these tests also prove the authoritative API is in
// use; see scripts/diagnose-firestore-build-reads.ts.
async function assertServerFailureRejects(
  fn: () => Promise<unknown>
): Promise<void> {
  await withEnv(CONFIGURED_ENV, () =>
    assert.rejects(
      fn(),
      (e: unknown) => (e as { code?: string }).code === "unavailable"
    )
  );
}

describe("hasFirebaseConfig", () => {
  it("is false when the public config is absent", async () => {
    await withEnv({}, () => assert.equal(hasFirebaseConfig(), false));
  });

  it("is true when the public config is present", async () => {
    await withEnv(CONFIGURED_ENV, () => assert.equal(hasFirebaseConfig(), true));
  });
});

describe("unconfigured builds (no Firebase config)", () => {
  it("getBeers returns [] without initializing Firebase", async () => {
    const { getBeers } = await import("@/lib/beers");
    await assertUnconfiguredFallback(() => getBeers(), []);
  });

  it("getVenues returns [] without initializing Firebase", async () => {
    const { getVenues } = await import("@/lib/venues");
    await assertUnconfiguredFallback(() => getVenues(), []);
  });

  it("getBeerBySlug returns null without initializing Firebase", async () => {
    const { getBeerBySlug } = await import("@/lib/beers");
    await assertUnconfiguredFallback(() => getBeerBySlug("any-slug"), null);
  });

  it("getBeerStaticParams returns [] without initializing Firebase", async () => {
    const { getBeerStaticParams } = await import("@/lib/beers");
    await assertUnconfiguredFallback(() => getBeerStaticParams(), []);
  });
});

describe("configured builds with an unreachable Firestore", () => {
  it("getBeers rejects instead of resolving an empty catalog", async () => {
    const { getBeers } = await import("@/lib/beers");
    await assertServerFailureRejects(() => getBeers());
  });

  it("getVenues rejects instead of resolving an empty list", async () => {
    const { getVenues } = await import("@/lib/venues");
    await assertServerFailureRejects(() => getVenues());
  });

  it("getBeerBySlug rejects instead of becoming a false 404", async () => {
    const { getBeerBySlug } = await import("@/lib/beers");
    await assertServerFailureRejects(() => getBeerBySlug("any-slug"));
  });

  it("getBeerStaticParams rejects instead of enumerating zero slugs", async () => {
    const { getBeerStaticParams } = await import("@/lib/beers");
    await assertServerFailureRejects(() => getBeerStaticParams());
  });
});

describe("build-time read source guards", () => {
  const beersSource = fs.readFileSync(
    path.join(process.cwd(), "lib", "beers.ts"),
    "utf8"
  );
  const venuesSource = fs.readFileSync(
    path.join(process.cwd(), "lib", "venues.ts"),
    "utf8"
  );
  const pageSource = fs.readFileSync(
    path.join(process.cwd(), "app", "(pages)", "beers", "[slug]", "page.tsx"),
    "utf8"
  );

  function section(
    source: string,
    startMarker: string,
    endMarker?: string
  ): string {
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
    if (endMarker === undefined) return source.slice(start);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
    return source.slice(start, end);
  }

  it("no public build-time read uses the cache-fallback getDocs", () => {
    // `getDocs(` — with the paren — matches a call site but not
    // `getDocsFromServer(`. Comments must not write it with parens.
    assert.ok(!beersSource.includes("getDocs("));
    assert.ok(!venuesSource.includes("getDocs("));
  });

  it("getBeers skips unconfigured builds and reads authoritatively", () => {
    const fn = section(
      beersSource,
      "export async function getBeers",
      "export const getBeerBySlug"
    );
    assert.ok(fn.includes("hasFirebaseConfig()"));
    assert.ok(fn.includes("return [];"));
    assert.ok(fn.includes("getDocsFromServer(publicBeersQuery())"));
    // The mapping shape is part of the public contract.
    assert.ok(fn.includes("snapshot.docs.map((doc) => doc.data() as Beer)"));
  });

  it("getBeerBySlug skips unconfigured builds and reads authoritatively", () => {
    const fn = section(
      beersSource,
      "export const getBeerBySlug",
      "export async function getBeerStaticParams"
    );
    assert.ok(fn.includes("hasFirebaseConfig()"));
    assert.ok(fn.includes("return null;"));
    assert.ok(fn.includes('where("slug", "==", slug)'));
    assert.ok(fn.includes('where("isPublic", "==", true)'));
    assert.ok(fn.includes("getDocsFromServer("));
    // A genuinely empty result is still a legitimate `null` → 404, not an
    // outage.
    assert.ok(fn.includes("snapshot.empty"));
  });

  it("getBeerStaticParams skips unconfigured builds and reads authoritatively", () => {
    const fn = section(
      beersSource,
      "export async function getBeerStaticParams"
    );
    assert.ok(fn.includes("hasFirebaseConfig()"));
    assert.ok(fn.includes("return [];"));
    assert.ok(fn.includes("getDocsFromServer(publicBeersQuery())"));
  });

  it("getVenues skips unconfigured builds and reads authoritatively", () => {
    const fn = section(venuesSource, "export async function getVenues");
    assert.ok(fn.includes("hasFirebaseConfig()"));
    assert.ok(fn.includes("return [];"));
    assert.ok(fn.includes('where("isPublic", "==", true)'));
    assert.ok(fn.includes('orderBy("sortOrder", "asc")'));
    assert.ok(fn.includes("getDocsFromServer("));
    assert.ok(fn.includes("snapshot.docs.map((doc) => doc.data() as Venue)"));
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
