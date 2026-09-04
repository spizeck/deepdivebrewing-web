import "server-only";
import { getFirebaseAdminAuth, getFirebaseAdminDb } from "@/lib/firebase-admin";
import { normalizeEmail } from "@/lib/admin-auth";
import { Timestamp } from "firebase-admin/firestore";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  const rawEmail = process.env.SUPER_ADMIN_EMAIL;
  if (!rawEmail) {
    console.error(
      "Error: SUPER_ADMIN_EMAIL is not set. Set it in your environment before running this script."
    );
    process.exit(1);
  }

  const email = normalizeEmail(rawEmail);
  console.log(`Bootstrap target email: ${email}`);

  const auth = getFirebaseAdminAuth();
  const db = getFirebaseAdminDb();

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

  if (needsClaim) {
    await auth.setCustomUserClaims(userRecord.uid, {
      admin: true,
      role: "superadmin",
    });
    console.log("Custom claim set.");
  }

  const now = Timestamp.now();
  await recordRef.set(
    {
      email,
      role: "superadmin",
      status: "active",
      createdAt: recordData?.createdAt ?? now,
      createdBy: recordData?.createdBy ?? userRecord.uid,
      updatedAt: now,
      updatedBy: userRecord.uid,
      lastLoginAt: now,
    },
    { merge: true }
  );
  console.log("adminUsers record updated.");

  console.log(
    "Bootstrap complete. Ask the superadmin to sign out and sign back in to refresh their ID token."
  );
}

main().catch((error) => {
  console.error("Bootstrap failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
