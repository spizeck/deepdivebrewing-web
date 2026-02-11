import { collection, getDocs, query, where, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Venue } from "@/lib/types";

export async function getVenues(): Promise<Venue[]> {
  const q = query(
    collection(db, "venues"),
    where("isPublic", "==", true),
    orderBy("sortOrder", "asc")
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => doc.data() as Venue);
}
