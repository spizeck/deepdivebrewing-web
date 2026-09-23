import {
  collection,
  getDocsFromServer,
  query,
  where,
  orderBy,
} from "firebase/firestore";
import { getFirebaseDb, hasFirebaseConfig } from "@/lib/firebase";
import type { Venue } from "@/lib/types";

/**
 * Public venue list for /where-to-buy. Same read contract as the beer
 * helpers in `lib/beers.ts`: an unconfigured build returns `[]` without
 * initializing Firebase, while a configured build reads via
 * `getDocsFromServer` so a backend failure throws and fails the build
 * rather than silently rendering "no partner locations". A legitimately
 * empty public venue list remains a valid result.
 */
export async function getVenues(): Promise<Venue[]> {
  if (!hasFirebaseConfig()) {
    return [];
  }
  const q = query(
    collection(getFirebaseDb(), "venues"),
    where("isPublic", "==", true),
    orderBy("sortOrder", "asc")
  );
  const snapshot = await getDocsFromServer(q);
  return snapshot.docs.map((doc) => doc.data() as Venue);
}
