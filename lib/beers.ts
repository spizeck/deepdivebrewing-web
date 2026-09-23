import { cache } from "react";
import {
  collection,
  getDocsFromServer,
  query,
  where,
  orderBy,
} from "firebase/firestore";
import { getFirebaseDb, hasFirebaseConfig } from "@/lib/firebase";
import type { Beer } from "@/lib/types";

function publicBeersQuery() {
  return query(
    collection(getFirebaseDb(), "beers"),
    where("isPublic", "==", true),
    orderBy("sortOrder", "asc")
  );
}

/**
 * Public beer catalog for build-time renders (homepage, /beers,
 * /where-to-buy, sitemap). Same read contract as `getBeerStaticParams`:
 * an unconfigured build returns `[]` without initializing Firebase, while
 * a configured build reads via `getDocsFromServer` — never `getDocs`,
 * which silently resolves from the offline cache on backend failure,
 * indistinguishable from a legitimately empty catalog. A server read
 * either returns the true result (a valid empty catalog included) or
 * throws, failing the build rather than deploying an empty one.
 */
export async function getBeers(): Promise<Beer[]> {
  if (!hasFirebaseConfig()) {
    return [];
  }
  const snapshot = await getDocsFromServer(publicBeersQuery());
  return snapshot.docs.map((doc) => doc.data() as Beer);
}

// React cache() dedupes the generateMetadata + page render reads for the
// same slug within a single render, so each beer page costs one Firestore
// read instead of two.
//
// Same read contract as `getBeers`: unconfigured builds return `null`
// without initializing Firebase; configured builds read from the server,
// so a backend failure throws (failing the build) instead of surfacing as
// a missing beer. A genuinely absent public slug still resolves `null`,
// which `notFound()` turns into a legitimate 404.
export const getBeerBySlug = cache(
  async (slug: string): Promise<Beer | null> => {
    if (!hasFirebaseConfig()) {
      return null;
    }
    const q = query(
      collection(getFirebaseDb(), "beers"),
      where("slug", "==", slug),
      where("isPublic", "==", true)
    );
    const snapshot = await getDocsFromServer(q);
    if (snapshot.empty) return null;
    return snapshot.docs[0].data() as Beer;
  }
);

/**
 * Slugs for `generateStaticParams` on /beers/[slug], from the canonical
 * public-beers query.
 *
 * Semantics verified against the installed Firebase SDK in Node
 * (build-time reads, scripts/diagnose-firestore-build-reads.ts):
 * - Unconfigured build (CI, local without .env.local): returns `[]`
 *   without initializing Firebase — credential-free builds are
 *   intentional.
 * - Configured build: `getDocsFromServer` (not `getDocs`) is deliberate.
 *   Plain `getDocs` silently resolves from the offline cache on backend
 *   failure, which is indistinguishable from a legitimately empty catalog.
 *   A server read either returns the true result — including a valid empty
 *   catalog — or throws (unavailable/permission-denied), failing the build
 *   instead of deploying zero beer pages.
 */
export async function getBeerStaticParams(): Promise<{ slug: string }[]> {
  if (!hasFirebaseConfig()) {
    return [];
  }
  const snapshot = await getDocsFromServer(publicBeersQuery());
  return snapshot.docs.map((doc) => ({ slug: (doc.data() as Beer).slug }));
}
