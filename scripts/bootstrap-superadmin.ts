import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { dropUndefinedValues } from "@/lib/admin-audit-common";
import { getProtectedAdminEmail, normalizeEmail } from "@/lib/admin-common";

const dryRun = process.argv.includes("--dry-run");

function getPrivateKey() {
  const key = process.env.FIREBASE_ADMIN_PRIVATE_KEY;
  if (!key) return "";
  return key.replace(/\\n/g, "\n");
}

function getFirebaseAdminApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;

  const projectId =
    process.env.FIREBASE_ADMIN_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
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
  const protectedEmail = getProtectedAdminEmail();
  if (!protectedEmail) {
    console.error(
      "Error: SUPER_ADMIN_EMAIL is not set. Set it in your environment before running this script."
    );
    process.exit(1);
  }

  const email = normalizeEmail(protectedEmail);
  console.log(`Bootstrap target email: ${email}`);

  const auth = getAuth(getFirebaseAdminApp());
  const db = getFirestore(getFirebaseAdminApp());

  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
  } catch (error) {
    console.error(
      "Error: No Firebase Authentication user found with that email. The superadmin must sign in with Google at least once before running this script.",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }

  if (!userRecord.emailVerified) {
    console.error("Error: The superadmin email is not verified in Firebase Authentication.");
    process.exit(1);
  }

  const existingClaims = (userRecord.customClaims ?? {}) as Partial<{
    admin?: boolean;
    role?: string;
  }>;
  const needsClaim =
    existingClaims.admin !== true || existingClaims.role !== "superadmin";

  const recordRef = db.collection("adminUsers").doc(userRecord.uid);
  const recordSnap = await recordRef.get();
  const recordData = recordSnap.data();
  const needsRecord =
    !recordSnap.exists ||
    recordData?.role !== "superadmin" ||
    recordData?.status !== "active";

  if (!needsClaim && !needsRecord) {
    console.log("Superadmin is already configured correctly. No changes needed.");
    process.exit(0);
  }

  console.log("Planned changes:");
  if (needsClaim) {
    console.log("  - Set custom claim { admin: true, role: 'superadmin' }");
  }
  if (needsRecord) {
    console.log("  - Create or update adminUsers record as active superadmin");
  }

  if (dryRun) {
    console.log("Dry run complete. No changes were made.");
    process.exit(0);
  }

  // Set the custom claim first. If the Firestore write/audit fails afterwards,
  // we roll the claim back to the previous value so the bootstrap is not left
  // half-applied.
  const previousClaims = userRecord.customClaims ?? null;

  if (needsClaim) {
    try {
      await auth.setCustomUserClaims(userRecord.uid, {
        admin: true,
        role: "superadmin",
      });
      console.log("Custom claim set.");
    } catch (error) {
      console.error(
        "Failed to set custom claim:",
        error instanceof Error ? error.message : error
      );
      process.exit(1);
    }
  }

  // Commit the adminUsers record and the audit log in a single Firestore
  // transaction so an audit-write failure cannot leave the record updated
  // without an accompanying audit entry.
  try {
    await db.runTransaction(async (t) => {
      const snap = await t.get(recordRef);
      const currentData = snap.data();
      const now = Timestamp.now();

      const recordUpdate = {
        email,
        role: "superadmin",
        status: "active",
        createdAt: currentData?.createdAt ?? now,
        createdBy: currentData?.createdBy ?? userRecord.uid,
        updatedAt: now,
        updatedBy: userRecord.uid,
        lastLoginAt: now,
      };
      t.set(
        recordRef,
        dropUndefinedValues(recordUpdate) as Record<string, unknown>,
        { merge: true }
      );

      const auditRef = db.collection("adminAuditLogs").doc();
      const auditRecord = {
        action: "bootstrap" as const,
        targetUid: userRecord.uid,
        targetEmail: email,
        newRole: "superadmin" as const,
        newStatus: "active" as const,
        actingUid: userRecord.uid,
        actingEmail: email,
        metadata: { source: "bootstrap-script", needsClaim },
        timestamp: now,
      };
      t.set(auditRef, dropUndefinedValues(auditRecord) as Record<string, unknown>);
    });
    console.log("adminUsers record and audit log written atomically.");
  } catch (error) {
    console.error(
      "Failed to write admin record and audit log:",
      error instanceof Error ? error.message : error
    );

    if (needsClaim) {
      try {
        await auth.setCustomUserClaims(userRecord.uid, previousClaims);
        console.log("Rolled back custom claim to previous value.");
      } catch (rollbackError) {
        console.error(
          "Custom claim rollback also failed:",
          rollbackError instanceof Error ? rollbackError.message : rollbackError
        );
        console.error(
          "The superadmin claim may still be set without a matching adminUsers record or audit log."
        );
      }
    }

    process.exit(1);
  }

  console.log(
    "Bootstrap complete. Ask the superadmin to sign out and sign back in to refresh their ID token."
  );
}

main().catch((error) => {
  console.error("Bootstrap failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
