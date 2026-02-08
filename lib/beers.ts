import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Beer } from "@/lib/types";

export async function getBeers(): Promise<Beer[]> {
  const q = query(
    collection(db, "beers"),
    where("isPublic", "==", true),
    orderBy("sortOrder", "asc")
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => doc.data() as Beer);
}

export async function getBeerBySlug(slug: string): Promise<Beer | null> {
  const q = query(
    collection(db, "beers"),
    where("slug", "==", slug),
    where("isPublic", "==", true)
  );
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  return snapshot.docs[0].data() as Beer;
}
