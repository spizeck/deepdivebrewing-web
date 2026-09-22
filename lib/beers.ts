import { cache } from "react";
import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
} from "firebase/firestore";
import { getFirebaseDb, hasFirebaseConfig } from "@/lib/firebase";
import type { Beer } from "@/lib/types";

export async function getBeers(): Promise<Beer[]> {
  const q = query(
    collection(getFirebaseDb(), "beers"),
    where("isPublic", "==", true),
    orderBy("sortOrder", "asc")
  );
  const snapshot = await getDocs(q);
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
 * Map a beer list to `generateStaticParams` output, with a build-safety
 * guard: when Firebase is configured, an empty catalog means the build
 * could not enumerate Firestore (transient failure or offline fallback) —
 * not that the brewery publishes no beers. Failing the build is safer than
 * deploying a site with zero beer detail pages. When Firebase is
 * unconfigured (CI, local builds without .env.local), an empty list is the
 * documented intentional behavior and no params are generated.
 */
export function resolveBeerStaticParams(
  beers: Pick<Beer, "slug">[],
  firebaseConfigured: boolean
): { slug: string }[] {
  if (beers.length === 0 && firebaseConfigured) {
    throw new Error(
      "getBeers() returned no public beers while Firebase is configured. " +
        "Refusing to statically generate zero beer pages — check Firestore connectivity and configuration."
    );
  }
  return beers.map((beer) => ({ slug: beer.slug }));
}

/** Slugs for `generateStaticParams` on /beers/[slug], from the canonical beer source. */
export async function getBeerStaticParams(): Promise<{ slug: string }[]> {
  return resolveBeerStaticParams(await getBeers(), hasFirebaseConfig());
}
