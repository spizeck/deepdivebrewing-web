import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Build a Firebase Storage download URL from a bucket name and object path. */
export function storageDownloadUrl(bucket: string, objectPath: string): string {
  const encoded = encodeURIComponent(objectPath);
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encoded}?alt=media`;
}

/**
 * Resolve a beer image Storage path to a full download URL.
 *
 * Kept in this Firebase-free module so client components (BeerCard is rendered
 * inside the carousel and filter grid) can use it without pulling the Firebase
 * client SDK into public-route bundles. Importing it from lib/beers.ts would
 * drag in firebase/firestore for every page that renders a beer card.
 */
export function beerImageUrl(path: string): string {
  return storageDownloadUrl(
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
    path
  );
}
