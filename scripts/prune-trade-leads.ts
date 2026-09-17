/**
 * Prune expired trade leads — deletes `tradeLeads` documents whose retention
 * anchor (`updatedAt`, falling back to `createdAt`) is at or before the
 * 24-month cutoff.
 *
 * Usage:
 *   npm run prune:trade-leads              # dry run — prints counts + doc IDs
 *   npm run prune:trade-leads -- --delete  # actually delete expired leads
 *
 * Prerequisites:
 *   - FIREBASE_ADMIN_* credentials in .env.local (loaded via --env-file)
 *   - Operator-level Firebase access
 *
 * Safety: dry-run is the default; deletion requires the explicit --delete
 * flag. Output contains document IDs and aggregate counts only — never
 * submitted PII. Leads with unparseable timestamps are reported and kept.
 */

import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  tradeLeadRetentionCutoff,
  tradeLeadRetentionStatus,
  TRADE_LEADS_COLLECTION,
  TRADE_LEAD_RETENTION_MONTHS,
} from "@/lib/trade-leads-common";

const DELETE = process.argv.includes("--delete");

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

async function main() {
  const db = getFirestore(getFirebaseAdminApp());
  const cutoff = tradeLeadRetentionCutoff(new Date());

  console.log(
    `${DELETE ? "DELETE" : "DRY-RUN"} — retention ${TRADE_LEAD_RETENTION_MONTHS} months, cutoff ${cutoff.toISOString()}`
  );

  const snapshot = await db.collection(TRADE_LEADS_COLLECTION).get();
  const expired: string[] = [];
  let retained = 0;
  let unknown = 0;

  for (const doc of snapshot.docs) {
    const status = tradeLeadRetentionStatus(doc.data(), cutoff);
    if (status === "expired") expired.push(doc.id);
    else if (status === "unknown") unknown++;
    else retained++;
  }

  console.log(
    `Scanned ${snapshot.size} lead(s): ${expired.length} expired, ${retained} within retention, ${unknown} skipped (unreadable timestamp)`
  );

  if (expired.length > 0) {
    console.log("Expired lead document IDs:");
    for (const id of expired) console.log(`  - ${id}`);
  }

  if (!DELETE) {
    if (expired.length > 0) {
      console.log(
        "\nDry run only — re-run with `--delete` to remove these documents."
      );
    }
    return;
  }

  if (expired.length === 0) {
    console.log("Nothing to delete.");
    return;
  }

  // Sequential deletes are fine at this volume and keep failure handling
  // simple — a failed delete aborts with the error, remaining docs untouched.
  for (const id of expired) {
    await db.collection(TRADE_LEADS_COLLECTION).doc(id).delete();
    console.log(`  deleted ${id}`);
  }
  console.log(`Deleted ${expired.length} lead(s).`);
}

main().catch((err) => {
  console.error("Prune failed:", err);
  process.exit(1);
});
