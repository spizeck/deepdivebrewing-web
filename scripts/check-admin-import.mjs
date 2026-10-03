// Server-runtime smoke check for the firebase-admin dependency chain.
//
// Why this exists: a jose/jwks-rsa combination under firebase-admin can
// install, typecheck, and `next build` cleanly yet crash when the SDK is
// imported in the real Node server runtime (the nfl-picks Vercel outage,
// ERR_REQUIRE_ESM). This script loads the same entrypoints through plain
// Node ESM — no bundler, no test transform — which is the closest
// credential-free signal to what actually runs on the server.
//
// Run: node scripts/check-admin-import.mjs   (wired into `npm test`)

import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";

const entrypoints = {
  "firebase-admin/app": ["initializeApp", "cert", "getApps"],
  "firebase-admin/auth": ["getAuth"],
  "firebase-admin/firestore": ["getFirestore"],
  // stripe (payments, #155): the class export is what lib/stripe.ts
  // instantiates — a CJS/ESM packaging break would only surface at runtime.
  stripe: ["default"],
};

// firebase-admin's exports map does not expose ./package.json, so locate
// it via Node's own package resolution.
const pkgJsonPath = findPackageJSON("firebase-admin", import.meta.url);
const { version } = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
if (!version.startsWith("14.")) {
  console.error(
    `firebase-admin@${version} loaded — expected the 14.x line. ` +
      `See docs/TECHNICAL.md and issue #141 before changing this.`,
  );
  process.exit(1);
}

for (const [entry, names] of Object.entries(entrypoints)) {
  const mod = await import(entry);
  for (const name of names) {
    if (typeof mod[name] !== "function") {
      console.error(`${entry}: expected export "${name}" to be a function`);
      process.exit(1);
    }
  }
}

console.log(`firebase-admin@${version}: server import chain OK`);
