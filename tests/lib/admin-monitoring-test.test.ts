// TEMPORARY — covers the Issue #92 browser verification control. Remove
// with components/admin-monitoring-test.tsx after production confirmation.
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const read = (rel: string) =>
  fs.readFileSync(path.join(process.cwd(), ...rel.split("/")), "utf8");

const control = read("components/admin-monitoring-test.tsx");
const workspace = read("components/admin-workspace.tsx");
const dashboard = read("components/admin-dashboard.tsx");

// Every file that references the verification control.
function usages() {
  const hits: string[] = [];
  for (const dir of ["app", "components"]) {
    for (const entry of fs.readdirSync(dir, { recursive: true })) {
      const rel = `${dir}/${String(entry)}`.replaceAll("\\", "/");
      if (!/\.(tsx?|jsx?)$/.test(rel)) continue;
      if (rel === "components/admin-monitoring-test.tsx") continue;
      if (read(rel).includes("AdminMonitoringTest")) hits.push(rel);
    }
  }
  return hits;
}

describe("browser Sentry verification control", () => {
  it("uses the already-initialized browser SDK — no second init", () => {
    assert.ok(control.includes('"use client"'));
    assert.ok(control.includes('from "@sentry/nextjs"'));
    assert.ok(control.includes("Sentry.captureException"));
    assert.ok(control.includes("Sentry.flush"));
    assert.ok(!control.includes("Sentry.init"));
  });

  it("attaches the harmless verification tag and no user identity", () => {
    assert.ok(control.includes("browser-monitoring-test"));
    for (const forbidden of [
      "setUser",
      "getIdToken",
      "user.email",
      "user.uid",
      "actor",
    ]) {
      assert.ok(
        !control.includes(forbidden),
        `control must not attach ${forbidden}`
      );
    }
  });

  it("embeds only fake probe values and no credentials", () => {
    assert.ok(control.includes("test@example.com"));
    assert.ok(control.includes("ddb-browser-probe"));
    assert.ok(control.includes("https://example.com/path"));
    for (const forbidden of [
      "NEXT_PUBLIC_SENTRY_DSN",
      "SENTRY_DSN",
      "SENTRY_AUTH_TOKEN",
      "ingest.sentry.io",
      "deepdivebrewing.com",
      "@deepdivebrewing",
    ]) {
      assert.ok(
        !control.includes(forbidden),
        `control must not contain ${forbidden}`
      );
    }
  });

  it("is rendered only inside the authenticated admin surface", () => {
    // AdminWorkspace renders only after AdminDashboard has verified an
    // active admin actor — every earlier return covers sign-in, denial,
    // bootstrap, and invitation states.
    assert.ok(workspace.includes("<AdminMonitoringTest />"));
    assert.ok(dashboard.includes("<AdminWorkspace"));
    assert.ok(dashboard.includes('is not authorized for admin access'));
    const hits = usages();
    assert.deepEqual(hits, ["components/admin-workspace.tsx"]);
  });

  it("shows a bounded, non-crashing result", () => {
    // Deliberate capture + flush — no thrown exception, no uncaught path.
    assert.ok(control.includes("Sentry.flush(2000)"));
    assert.ok(!control.includes("throw "));
    assert.ok(control.includes('role="status"'));
  });
});
