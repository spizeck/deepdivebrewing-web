import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import test from "node:test";

/**
 * Guards the module split that keeps Firestore-only routes from importing
 * the Admin Auth dependency graph (jwks-rsa -> jose), the failure class
 * behind the nfl-picks Vercel outage: a firebase-admin/auth import that
 * installs and builds cleanly but crashes the deployed serverless
 * function with ERR_REQUIRE_ESM.
 *
 * Intentionally no firebase-admin mocks — these tests exercise the real
 * installed dependency tree through Node's own resolution.
 */

const require = createRequire(import.meta.url);

test("firebase-admin resolves a 14.x release", () => {
  const pkgPath = findPackageJSON("firebase-admin", import.meta.url);
  assert.ok(pkgPath, "firebase-admin package.json not found");
  const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.match(version, /^14\./, `expected firebase-admin 14.x, found ${version}`);
});

test("firebase-admin/auth loads through require() without ERR_REQUIRE_ESM", () => {
  // The exact production failure: evaluating the auth graph (jwks-rsa ->
  // jose) threw ERR_REQUIRE_ESM inside the Vercel server bundle.
  assert.doesNotThrow(() => {
    require("firebase-admin/auth");
  });
});

test("jwks-rsa resolves a require()-able jose build", () => {
  // jwks-rsa is CommonJS and calls require("jose"); jose@6 ships no CJS
  // build, which crashed this repo's Vercel Preview with ERR_REQUIRE_ESM
  // (verified on PR #142 before the pin was added). The package.json
  // override pins jwks-rsa's jose to 5.x — this guards that resolution.
  const jwksRsaDir = require("path").dirname(
    require.resolve("jwks-rsa/package.json"),
  );
  const joseEntry = require.resolve("jose", { paths: [jwksRsaDir] });
  const josePkg = require(require.resolve("jose/package.json", {
    paths: [jwksRsaDir],
  })) as { version: string };

  assert.ok(
    Number(josePkg.version.split(".")[0]) < 6,
    `jose@${josePkg.version} must be < 6 (6.x is ESM-only); resolved entry: ${joseEntry}`,
  );
  assert.doesNotThrow(
    () => require(joseEntry),
    `jwks-rsa's jose must be require()-able; resolved: ${joseEntry}`,
  );
});

test("firebase-admin entrypoints import in plain Node", async () => {
  const app = await import("firebase-admin/app");
  assert.equal(typeof app.initializeApp, "function");
  const auth = await import("firebase-admin/auth");
  assert.equal(typeof auth.getAuth, "function");
  const firestore = await import("firebase-admin/firestore");
  assert.equal(typeof firestore.getFirestore, "function");
});

test("Firestore-only sources never import the admin Auth graph", () => {
  const firestoreOnlySources = [
    "lib/firebase-admin-app.ts",
    "lib/firebase-admin-db.ts",
    "lib/admin-audit.ts",
    "lib/admin-invitations.ts",
    "lib/admin-users.ts",
    "lib/trade-leads.ts",
    "app/api/admin/invitations/[id]/resend/route.ts",
  ];

  // Quoted module specifiers only, so explanatory comments mentioning the
  // auth package do not trip the guard.
  const authSpecifier = /["'][^"']*(firebase-admin\/auth|firebase-admin-auth)["']/;

  for (const rel of firestoreOnlySources) {
    const source = readFileSync(rel, "utf8").replace(/\/\/.*$/gm, "");
    assert.equal(
      authSpecifier.test(source),
      false,
      `${rel} must not import the Admin Auth module graph`,
    );
  }
});
