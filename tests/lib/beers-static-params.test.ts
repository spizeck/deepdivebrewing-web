import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { resolveBeerStaticParams } from "@/lib/beers";
import { hasFirebaseConfig } from "@/lib/firebase";

describe("resolveBeerStaticParams", () => {
  it("maps beer slugs to generateStaticParams output shape", () => {
    const params = resolveBeerStaticParams(
      [{ slug: "neipa" }, { slug: "pale-lager" }, { slug: "stout" }],
      true
    );
    assert.deepEqual(params, [
      { slug: "neipa" },
      { slug: "pale-lager" },
      { slug: "stout" },
    ]);
  });

  it("returns an empty list when Firebase is not configured", () => {
    // CI/local builds without NEXT_PUBLIC_FIREBASE_* intentionally produce
    // no beer pages — the credential-free build guarantee.
    assert.deepEqual(resolveBeerStaticParams([], false), []);
  });

  it("throws when Firebase is configured but the catalog is empty", () => {
    // A configured-but-empty result means the build could not enumerate
    // Firestore — failing the build is safer than deploying zero pages.
    assert.throws(() => resolveBeerStaticParams([], true), /no public beers/);
  });
});

describe("hasFirebaseConfig", () => {
  const KEYS = [
    "NEXT_PUBLIC_FIREBASE_API_KEY",
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    "NEXT_PUBLIC_FIREBASE_APP_ID",
  ] as const;

  it("is false when the public config is absent", () => {
    const originals = KEYS.map((k) => process.env[k]);
    for (const k of KEYS) delete process.env[k];
    try {
      assert.equal(hasFirebaseConfig(), false);
    } finally {
      KEYS.forEach((k, i) => {
        if (originals[i] === undefined) delete process.env[k];
        else process.env[k] = originals[i];
      });
    }
  });

  it("is true when the public config is present", () => {
    const originals = KEYS.map((k) => process.env[k]);
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "key";
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "project";
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID = "app";
    try {
      assert.equal(hasFirebaseConfig(), true);
    } finally {
      KEYS.forEach((k, i) => {
        if (originals[i] === undefined) delete process.env[k];
        else process.env[k] = originals[i];
      });
    }
  });
});

describe("beer detail page static generation", () => {
  const pageSource = fs.readFileSync(
    path.join(process.cwd(), "app", "(pages)", "beers", "[slug]", "page.tsx"),
    "utf8"
  );

  it("disables dynamic params so unknown slugs 404 instead of rendering", () => {
    assert.ok(pageSource.includes("export const dynamicParams = false"));
  });

  it("enumerates slugs through the canonical beer service", () => {
    assert.ok(pageSource.includes("export async function generateStaticParams()"));
    assert.ok(pageSource.includes("getBeerStaticParams()"));
    // The page must not contain its own Firestore query.
    assert.ok(!pageSource.includes("firebase/firestore"));
    assert.ok(!pageSource.includes("collection("));
  });
});
