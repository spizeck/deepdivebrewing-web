/**
 * Seed script for Firebase Firestore — writes all venues from venue-seed-data.json
 *
 * Usage:
 *   npx tsx scripts/seed-venues.ts
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { resolve } from "path";

// --- Config ---
const SERVICE_ACCOUNT_PATH = resolve(
  __dirname,
  "../deepdivebrewing-web-firebase-adminsdk-serviceAccount.json"
);
const COLLECTION = "venues";
const SEED_DATA_PATH = resolve(__dirname, "venue-seed-data.json");

// --- Init Firebase Admin ---
const serviceAccount = JSON.parse(
  readFileSync(SERVICE_ACCOUNT_PATH, "utf-8")
);

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();

// --- Seed ---
async function seed() {
  const venues = JSON.parse(readFileSync(SEED_DATA_PATH, "utf-8"));

  console.log(`Seeding ${venues.length} venues into "${COLLECTION}" collection...`);

  const batch = db.batch();

  for (const venue of venues) {
    const docRef = db.collection(COLLECTION).doc(venue.slug);
    batch.set(docRef, venue, { merge: true });
    console.log(`  + ${venue.name} (${venue.slug})`);
  }

  await batch.commit();
  console.log(`\nDone! ${venues.length} venues seeded successfully.`);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
