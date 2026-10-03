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
import {
  getFirestore,
  type DocumentReference,
} from "firebase-admin/firestore";
import {
  tradeLeadRetentionCutoff,
  tradeLeadRetentionStatus,
  TRADE_LEADS_COLLECTION,
  TRADE_LEAD_RETENTION_MONTHS,
} from "@/lib/trade-leads-common";
import { TRADE_LEAD_ACTIVITIES_SUBCOLLECTION } from "@/lib/trade-leads-admin-common";
import { TRADE_LEAD_COMMUNICATIONS_SUBCOLLECTION } from "@/lib/trade-leads-email-common";

const DELETE = process.argv.includes("--delete");

// Comfortably below Firestore's 500-write batch limit.
const SUBCOLLECTION_DELETE_BATCH = 450;

// Subcollections a lead can own (#150 activities, #152 communications) —
// deleting the parent document does not cascade, so each is swept after the
// lead's own transaction commits.
const LEAD_SUBCOLLECTIONS = [
  TRADE_LEAD_ACTIVITIES_SUBCOLLECTION,
  TRADE_LEAD_COMMUNICATIONS_SUBCOLLECTION,
];

// Deletes every document in one of a lead's subcollections in bounded write
// batches.
async function deleteLeadSubcollection(
  leadRef: DocumentReference,
  name: string
): Promise<number> {
  const subcollection = leadRef.collection(name);
  let removed = 0;
  for (;;) {
    const page = await subcollection.limit(SUBCOLLECTION_DELETE_BATCH).get();
    if (page.empty) return removed;
    const batch = leadRef.firestore.batch();
    for (const doc of page.docs) {
      batch.delete(doc.ref);
    }
    await batch.commit();
    removed += page.size;
  }
}

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

  // Re-verify each document inside a transaction before deleting so a lead
  // updated between scan and delete (new activity extends retention) is
  // kept. Deleting a document does not cascade to subcollections — the
  // activities history and communications are removed afterwards in bounded
  // batches. Doing it after commit (rather than inside the transaction)
  // keeps the transaction under Firestore's per-transaction write limit no
  // matter how long a lead's history is, and can never wipe a live lead's
  // timeline: if the recheck fails, the lead — and its history — is left
  // untouched.
  const collection = db.collection(TRADE_LEADS_COLLECTION);
  let deleted = 0;
  for (const id of expired) {
    const ref = collection.doc(id);
    const removed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (
        !fresh.exists ||
        tradeLeadRetentionStatus(fresh.data() ?? {}, cutoff) !== "expired"
      ) {
        return false;
      }
      tx.delete(ref);
      return true;
    });
    if (!removed) {
      console.log(`  kept ${id} (changed since scan)`);
      continue;
    }

    deleted++;
    let subdocsRemoved = 0;
    try {
      for (const name of LEAD_SUBCOLLECTIONS) {
        subdocsRemoved += await deleteLeadSubcollection(ref, name);
      }
      console.log(`  deleted ${id} (+${subdocsRemoved} subcollection records)`);
    } catch (err) {
      // The lead document is already gone; leftover subcollection docs are
      // unreachable by the app and denied to clients — report for a manual
      // sweep rather than failing the whole run.
      console.warn(
        `  deleted ${id} (+${subdocsRemoved} subcollection records) — ` +
          "remaining history cleanup failed; sweep the " +
          `${LEAD_SUBCOLLECTIONS.join("/")} subcollections for ${id} manually.`,
        err
      );
    }
  }
  console.log(`Deleted ${deleted} lead(s).`);
}

main().catch((err) => {
  console.error("Prune failed:", err);
  process.exit(1);
});
