/**
 * Seed script for Firebase Firestore — writes all beers from beer-seed-data.json
 *
 * Usage:
 *   npx tsx scripts/seed-beers.ts
 *
 * Prerequisites:
 *   - npm install -D firebase-admin tsx  (if not already installed)
 *   - Service account JSON at project root or set GOOGLE_APPLICATION_CREDENTIALS
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
const COLLECTION = "beers";
const SEED_DATA_PATH = resolve(__dirname, "beer-seed-data.json");

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
  const beers = JSON.parse(readFileSync(SEED_DATA_PATH, "utf-8"));

  console.log(`Seeding ${beers.length} beers into "${COLLECTION}" collection...`);

  const batch = db.batch();

  for (const beer of beers) {
    const docRef = db.collection(COLLECTION).doc(beer.slug);
    batch.set(docRef, beer, { merge: true });
    console.log(`  + ${beer.name} (${beer.slug})`);
  }

  await batch.commit();
  console.log(`\nDone! ${beers.length} beers seeded successfully.`);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
