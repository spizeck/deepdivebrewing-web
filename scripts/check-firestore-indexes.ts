/**
 * Firestore index drift check — compares firestore.indexes.json (the
 * repository's canonical index configuration) against the indexes
 * actually deployed in the target Firebase project, including each
 * deployed index's build state.
 *
 * Usage:
 *   npm run check:indexes              # report drift; non-zero on real drift
 *   npm run check:indexes -- --json    # machine-readable report
 *
 * Prerequisites:
 *   - FIREBASE_ADMIN_* credentials in .env.local (loaded via --env-file)
 *   - READ-ONLY: this script never creates, updates, or deletes indexes
 *
 * Exit codes:
 *   0 — no drift (warnings such as "still building" do not fail)
 *   1 — drift found: declared index missing/mismatched in production,
 *       deployed index undeclared in the file, or NEEDS_REPAIR
 *   2 — could not complete the check (credentials/API failure)
 *
 * State semantics matter: a declared index that is deployed but still
 * CREATING is *not* drift — that is deployment timing, and flagging it
 * would false-alarm every index rollout. Undeclared deployed indexes are
 * reported for human review only; an index can look unused simply
 * because its query runs infrequently, so this script never decides a
 * deployed index is safe to delete.
 */

import { readFileSync } from "node:fs";
import { JWT } from "google-auth-library";

const JSON_OUTPUT = process.argv.includes("--json");
const INDEXES_FILE = "firestore.indexes.json";

interface RepoIndexField {
  fieldPath: string;
  order?: string;
  arrayConfig?: string;
}
interface RepoIndex {
  collectionGroup: string;
  queryScope: string;
  fields: RepoIndexField[];
}
interface RepoFieldOverride {
  collectionGroup: string;
  fieldPath: string;
  indexes: { order?: string; arrayConfig?: string; queryScope: string }[];
}

interface DeployedIndex {
  name: string;
  collectionGroup: string;
  queryScope: string;
  state: string;
  fields: { fieldPath: string; order?: string; arrayConfig?: string }[];
}

interface DeployedField {
  name: string;
  indexConfig?: {
    indexes?: {
      queryScope?: string;
      order?: string;
      arrayConfig?: string;
      state?: string;
    }[];
  };
}

// ---------------------------------------------------------------- auth

function getCredentials() {
  const projectId =
    process.env.FIREBASE_ADMIN_PROJECT_ID ??
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;
  const privateKey = (
    process.env.FIREBASE_ADMIN_PRIVATE_KEY ?? ""
  ).replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase Admin credentials. Set FIREBASE_ADMIN_PROJECT_ID, " +
        "FIREBASE_ADMIN_CLIENT_EMAIL, and FIREBASE_ADMIN_PRIVATE_KEY " +
        "(e.g. node --env-file=.env.local --import tsx scripts/check-firestore-indexes.ts)."
    );
  }
  return { projectId, clientEmail, privateKey };
}

async function adminFetch<T>(url: string, jwt: JWT): Promise<T> {
  const { token } = await jwt.getAccessToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} — ${url}`);
  }
  return (await res.json()) as T;
}

// ------------------------------------------------------------ normalize

// The canonical comparison key: collection group + ordered field list.
// __name__ is implicit in every Firestore index and never declared in
// the file, so it is stripped before comparing.
function indexKey(fields: { fieldPath: string }[]): string {
  return fields.map((f) => f.fieldPath).join("|");
}

function normalizeRepoIndex(idx: RepoIndex) {
  return {
    collectionGroup: idx.collectionGroup,
    queryScope: idx.queryScope,
    fields: idx.fields.map((f) => ({
      fieldPath: f.fieldPath,
      order: f.order,
      arrayConfig: f.arrayConfig,
    })),
    key: indexKey(idx.fields),
  };
}

function normalizeDeployedIndex(idx: DeployedIndex) {
  const fields = idx.fields.filter((f) => f.fieldPath !== "__name__");
  // The REST Index resource embeds the collection group in `name`:
  // projects/.../collectionGroups/{group}/indexes/{id}
  const group =
    idx.name.match(/collectionGroups\/([^/]+)\/indexes\//)?.[1] ??
    idx.collectionGroup;
  return {
    collectionGroup: group,
    queryScope: idx.queryScope,
    state: idx.state,
    fields: fields.map((f) => ({
      fieldPath: f.fieldPath,
      order: f.order,
      arrayConfig: f.arrayConfig,
    })),
    key: indexKey(fields),
    name: idx.name,
  };
}

function fieldsMatch(
  repo: { fieldPath: string; order?: string; arrayConfig?: string }[],
  deployed: { fieldPath: string; order?: string; arrayConfig?: string }[]
): boolean {
  if (repo.length !== deployed.length) return false;
  return repo.every(
    (rf, i) =>
      rf.fieldPath === deployed[i]!.fieldPath &&
      (rf.order ?? "ASCENDING") === (deployed[i]!.order ?? "ASCENDING") &&
      rf.arrayConfig === deployed[i]!.arrayConfig
  );
}

// ---------------------------------------------------------------- main

async function main() {
  const { projectId, clientEmail, privateKey } = getCredentials();
  const jwt = new JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/datastore"],
  });
  const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)`;

  const repoFile = JSON.parse(readFileSync(INDEXES_FILE, "utf8")) as {
    indexes?: RepoIndex[];
    fieldOverrides?: RepoFieldOverride[];
  };
  const repoIndexes = (repoFile.indexes ?? []).map(normalizeRepoIndex);
  const repoOverrides = repoFile.fieldOverrides ?? [];

  // Deployed inventory WITH build state — the `-` collection-group
  // wildcard lists every composite index in the (default) database.
  // Composite indexes can be listed across all collection groups with
  // the `-` wildcard; field configs cannot be listed unfiltered, so
  // each declared override is fetched by its exact field path.
  const indexPages = await adminFetch<{ indexes?: DeployedIndex[] }>(
    `${base}/collectionGroups/-/indexes`,
    jwt
  );
  const fieldPages = await Promise.all(
    repoOverrides.map((o) =>
      adminFetch<DeployedField | { error: { code: number } }>(
        `${base}/collectionGroups/${o.collectionGroup}/fields/${o.fieldPath}`,
        jwt
      ).catch(() => null)
    )
  );
  const deployedIndexes = (indexPages.indexes ?? []).map(
    normalizeDeployedIndex
  );

  type Finding = {
    kind:
      | "ok"
      | "building" // declared + deployed, still CREATING — timing, not drift
      | "missing" // declared but not deployed
      | "mismatch" // deployed but fields/scope differ
      | "needs_repair"
      | "undeclared"; // deployed but absent from the file
    collectionGroup: string;
    detail: string;
  };
  const findings: Finding[] = [];

  // 1. Every declared index must exist in production (any state).
  for (const repo of repoIndexes) {
    const match = deployedIndexes.find(
      (d) =>
        d.collectionGroup === repo.collectionGroup &&
        d.key === repo.key &&
        fieldsMatch(repo.fields, d.fields) &&
        d.queryScope === repo.queryScope
    );
    if (match) {
      if (match.state === "CREATING") {
        findings.push({
          kind: "building",
          collectionGroup: repo.collectionGroup,
          detail: `${repo.key} — still building (deployment timing, not drift)`,
        });
      } else if (match.state === "NEEDS_REPAIR") {
        findings.push({
          kind: "needs_repair",
          collectionGroup: repo.collectionGroup,
          detail: `${repo.key} — NEEDS_REPAIR in production`,
        });
      } else {
        findings.push({
          kind: "ok",
          collectionGroup: repo.collectionGroup,
          detail: `${repo.key} — READY`,
        });
      }
      continue;
    }
    // Same collection group, different fields or ordering → definition
    // mismatch; nothing in the group at all → missing.
    const sameGroup = deployedIndexes.find(
      (d) =>
        d.collectionGroup === repo.collectionGroup &&
        !fieldsMatch(repo.fields, d.fields)
    );
    findings.push({
      kind: sameGroup ? "mismatch" : "missing",
      collectionGroup: repo.collectionGroup,
      detail: sameGroup
        ? `${repo.key} — no deployed index with these fields in this collection group`
        : `${repo.key} — not deployed`,
    });
  }

  // 2. Every deployed composite index must be declared in the file.
  for (const deployed of deployedIndexes) {
    const declared = repoIndexes.some(
      (r) =>
        r.collectionGroup === deployed.collectionGroup &&
        r.key === deployed.key &&
        r.queryScope === deployed.queryScope
    );
    if (!declared) {
      findings.push({
        kind: "undeclared",
        collectionGroup: deployed.collectionGroup,
        detail:
          `${deployed.key} (${deployed.queryScope}, ${deployed.state}) — ` +
          `deployed but not in ${INDEXES_FILE}; add it or review for removal`,
      });
    }
  }

  // 3. Field overrides (single-field index exemptions / collection-group
  //    enables). Compare repo-declared overrides against the deployed
  //    field config fetched for each.
  for (const [i, override] of repoOverrides.entries()) {
    const field = fieldPages[i];
    if (!field || "error" in field) {
      findings.push({
        kind: "missing",
        collectionGroup: override.collectionGroup,
        detail: `field ${override.fieldPath} — override not found in production`,
      });
      continue;
    }
    const deployedIdx = field.indexConfig?.indexes ?? [];
    const missing = override.indexes.filter(
      (want) =>
        !deployedIdx.some(
          (got) =>
            got.queryScope === want.queryScope &&
            (got.order ?? "ASCENDING") === (want.order ?? "ASCENDING") &&
            got.arrayConfig === want.arrayConfig
        )
    );
    findings.push(
      missing.length
        ? {
            kind: "missing",
            collectionGroup: override.collectionGroup,
            detail: `field ${override.fieldPath} — ${missing.length} declared override index(es) not deployed`,
          }
        : {
            kind: "ok",
            collectionGroup: override.collectionGroup,
            detail: `field ${override.fieldPath} override — deployed`,
          }
    );
  }

  // -------------------------------------------------------------- report
  const counts = {
    ok: findings.filter((f) => f.kind === "ok").length,
    building: findings.filter((f) => f.kind === "building").length,
    missing: findings.filter((f) => f.kind === "missing").length,
    mismatch: findings.filter((f) => f.kind === "mismatch").length,
    needs_repair: findings.filter((f) => f.kind === "needs_repair").length,
    undeclared: findings.filter((f) => f.kind === "undeclared").length,
  };
  const drift =
    counts.missing + counts.mismatch + counts.needs_repair + counts.undeclared;

  if (JSON_OUTPUT) {
    console.log(
      JSON.stringify({ projectId, drift, counts, findings }, null, 2)
    );
  } else {
    console.log(`Firestore index drift check — project ${projectId}`);
    console.log(`  declared in ${INDEXES_FILE}: ${repoIndexes.length} composite + ${repoOverrides.length} field override(s)`);
    console.log(`  deployed composite indexes: ${deployedIndexes.length}`);
    console.log("");
    for (const f of findings) {
      const tag =
        f.kind === "ok"
          ? "OK       "
          : f.kind === "building"
            ? "BUILDING "
            : f.kind === "undeclared"
              ? "UNDECLARED"
              : f.kind.toUpperCase().padEnd(9);
      console.log(`  ${tag} ${f.collectionGroup}: ${f.detail}`);
    }
    console.log("");
    if (drift === 0) {
      const buildingNote =
        counts.building > 0
          ? ` (${counts.building} still building — deployment in progress, not drift)`
          : "";
      console.log(`No drift detected.${buildingNote}`);
    } else {
      console.log(
        `${drift} drift finding(s): ${counts.missing} missing, ` +
          `${counts.mismatch} mismatch, ${counts.needs_repair} needs_repair, ` +
          `${counts.undeclared} undeclared.` +
          (counts.building > 0 ? ` (${counts.building} still building — not counted)` : "")
      );
      console.log(
        "Fix: reconcile the file with production or run " +
          "`firebase deploy --only firestore:indexes`. Never --force: " +
          "undeclared deployed indexes may serve infrequent queries."
      );
    }
  }
  process.exit(drift === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(
    `check-firestore-indexes: ${error instanceof Error ? error.message : error}`
  );
  process.exit(2);
});
