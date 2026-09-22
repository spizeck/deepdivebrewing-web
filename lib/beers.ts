import { cache } from "react";
import {
  collection,
  getDocs,
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

export async function getBeers(): Promise<Beer[]> {
  const snapshot = await getDocs(publicBeersQuery());
  return snapshot.docs.map((doc) => doc.data() as Beer);
}

// React cache() dedupes the generateMetadata + page render reads for the
// same slug within a single render, so each beer page costs one Firestore
// read instead of two.
export const getBeerBySlug = cache(
  async (slug: string): Promise<Beer | null> => {
    const q = query(
      collection(getFirebaseDb(), "beers"),
      where("slug", "==", slug),
      where("isPublic", "==", true)
    );
    const snapshot = await getDocs(q);
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
