/**
 * Backfill the canonical `island` field on `venues` documents (Issue #134).
 *
 * Each legacy record encodes the island inside the free-text `locationName`
 * (e.g. "Windwardside, Saba", "Sint Maarten"). The migration splits that into
 * `{ island, locationName: locality }` via `resolveVenueGeography` in
 * lib/venue-filters.ts. Records whose location can't be classified
 * confidently — and records whose stored `island` disagrees with the parsed
 * location — are reported for owner review and never overwritten.
 *
 * Usage:
 *   npm run migrate:venue-islands              # dry run — prints the plan
 *   npm run migrate:venue-islands -- --write   # apply the planned updates
 *
 * Prerequisites:
 *   - FIREBASE_ADMIN_* credentials in .env.local (loaded via --env-file)
 *   - Operator-level Firebase access
 *
 * Safety: dry-run is the default; writes require the explicit --write flag.
 * The script is idempotent — already-migrated records are reported as
 * unchanged and skipped. Output is limited to venue slugs/names/locations,
 * which are public business data.
 */

import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { resolveVenueGeography } from "@/lib/venue-filters";
import { isVenueIsland } from "@/lib/venue-islands";
import type { Venue } from "@/lib/types";

const WRITE = process.argv.includes("--write");

function getPrivateKey() {
  const key = process.env.FIREBASE_ADMIN_PRIVATE_KEY;
  if (!key) return "";
  return key.replace(/\\n/g, "\n");
}

function getFirebaseAdminApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;

  const projectId =
    process.env.FIREBASE_ADMIN_PROJECT_ID ??
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = getPrivateKey();

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase Admin credentials. Set FIREBASE_ADMIN_PROJECT_ID, FIREBASE_ADMIN_CLIENT_EMAIL, and FIREBASE_ADMIN_PRIVATE_KEY."
    );
  }

  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

interface PlannedUpdate {
  slug: string;
  island: string;
  locality: string;
}

async function main() {
  const db = getFirestore(getFirebaseAdminApp());
  const snapshot = await db.collection("venues").orderBy("sortOrder", "asc").get();

  console.log(
    `${WRITE ? "WRITE" : "DRY-RUN"} — venue island migration (Issue #134)`
  );
  console.log(`Scanned ${snapshot.size} venue(s).`);

  const updates: PlannedUpdate[] = [];
  const conflicts: string[] = [];
  const ambiguous: string[] = [];
  let unchanged = 0;

  for (const docSnap of snapshot.docs) {
    const venue = docSnap.data() as Venue;
    const resolved = resolveVenueGeography(venue.locationName);
    const label = `${venue.name ?? docSnap.id} (${docSnap.id})`;

    if (isVenueIsland(venue.island)) {
      if (resolved && resolved.island !== venue.island) {
        conflicts.push(
          `${label}: stored island "${venue.island}" disagrees with locationName "${venue.locationName}" (resolves to "${resolved.island}")`
        );
        continue;
      }
      const locality = resolved ? resolved.locality : venue.locationName;
      if (!resolved) {
        // Island is already canonical; the location text is a pure locality
        // the map doesn't know — safe to keep verbatim.
        console.log(`  = ${label}: island "${venue.island}", locality "${venue.locationName}" (kept as-is)`);
        unchanged++;
        continue;
      }
      if (venue.locationName === locality) {
        console.log(`  = ${label}: already migrated (island "${venue.island}", locality "${locality}")`);
        unchanged++;
        continue;
      }
      updates.push({ slug: docSnap.id, island: venue.island, locality });
      console.log(
        `  ~ ${label}: island "${venue.island}" kept; locationName "${venue.locationName}" → locality "${locality}"`
      );
      continue;
    }

    if (!resolved) {
      ambiguous.push(`${label}: locationName "${venue.locationName}"`);
      continue;
    }

    updates.push({ slug: docSnap.id, island: resolved.island, locality: resolved.locality });
    console.log(
      `  + ${label}: locationName "${venue.locationName}" → island "${resolved.island}", locality "${resolved.locality}"`
    );
  }

  console.log(
    `\nPlan: ${updates.length} to update, ${unchanged} unchanged, ${conflicts.length} conflict(s), ${ambiguous.length} ambiguous.`
  );

  for (const line of conflicts) {
    console.log(`  CONFLICT ${line}`);
  }
  for (const line of ambiguous) {
    console.log(`  AMBIGUOUS ${line}`);
  }

  if (conflicts.length > 0 || ambiguous.length > 0) {
    console.log(
      "\nConflicting/ambiguous records were NOT changed — review them with the owner and re-run."
    );
  }

  if (!WRITE) {
    if (updates.length > 0) {
      console.log("\nDry run only — re-run with `--write` to apply these updates.");
    }
    return;
  }

  if (updates.length === 0) {
    console.log("Nothing to write.");
    return;
  }

  const collection = db.collection("venues");
  let written = 0;
  for (const update of updates) {
    // Re-verify inside a transaction so a venue edited between scan and
    // write keeps its newer island value rather than being overwritten.
    const ref = collection.doc(update.slug);
    const applied = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      const data = (fresh.data() ?? {}) as Venue;
      const reResolved = resolveVenueGeography(data.locationName);
      if (
        !reResolved ||
        reResolved.island !== update.island ||
        reResolved.locality !== update.locality ||
        (isVenueIsland(data.island) && data.island !== update.island)
      ) {
        return false;
      }
      tx.set(
        ref,
        { island: update.island, locationName: update.locality },
        { merge: true }
      );
      return true;
    });
    if (applied) {
      written++;
      console.log(`  wrote ${update.slug}`);
    } else {
      console.log(`  skipped ${update.slug} (island changed since scan)`);
    }
  }
  console.log(`Updated ${written} venue(s).`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
