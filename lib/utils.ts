import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Shared tactile feedback for interactive controls that are not `Button`
 * instances — record rows, lead cards, filter chips, disclosure controls,
 * icon buttons. `buttonVariants` carries the same press scale for shadcn
 * Buttons; keep the two in sync (see THEME_AND_BRANDING.md — Interactive
 * feedback).
 *
 * The transition list is explicit — the cheap paint properties the
 * existing hovers already use (color, background, border, opacity,
 * shadow) plus the press transform. `transition-all` is avoided on
 * purpose: it would also animate layout-affecting properties, e.g. the
 * width change when a submit label swaps to its loading text.
 * The press scale is gated by `motion-safe:` and the transition duration
 * drops to zero under `motion-reduce:`: reduced-motion sessions keep an
 * instant color/border acknowledgement with no animation at all.
 */
export const pressableClasses =
  "transition-[color,background-color,border-color,box-shadow,opacity,transform,translate,scale,rotate] duration-150 motion-reduce:duration-0 motion-safe:active:scale-[0.98]";

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
