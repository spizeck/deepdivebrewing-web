import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

function readRules(name: "firestore.rules" | "storage.rules"): string {
  return fs.readFileSync(path.join(process.cwd(), name), "utf8");
}

describe("firestore.rules", () => {
  const rules = readRules("firestore.rules");

  it("does not contain the legacy hard-coded admin email list", () => {
    const legacyEmails = [
      "chadnuttall1@gmail.com",
      "chad@seasaba.com",
      "katy@seasaba.com",
      "knuttall05@gmail.com",
      "timschwenck@gmail.com",
    ];
    for (const email of legacyEmails) {
      assert.strictEqual(
        rules.includes(email),
        false,
        `firestore.rules still contains legacy email: ${email}`
      );
    }
  });

  it("authorizes admin content writes via custom claims", () => {
    assert.ok(
      rules.includes("request.auth.token.admin == true"),
      "Expected admin claim check for privileged writes"
    );
  });

  it("requires an existing active adminUsers record for privileged access", () => {
    assert.ok(
      rules.includes("adminUsers/$(request.auth.uid)"),
      "Expected rules to look up the acting user's adminUsers record"
    );
    assert.ok(
      rules.includes("record.status == 'active'"),
      "Expected an active-status check on the adminUsers record"
    );
  });

  it("requires the adminUsers record role to match the token role", () => {
    assert.ok(
      rules.includes("record.role == request.auth.token.role"),
      "Expected role agreement between record and token claims"
    );
  });

  it("restricts administrator management to superadmins", () => {
    assert.ok(
      rules.includes("request.auth.token.role == 'superadmin'"),
      "Expected superadmin role check for adminUsers"
    );
  });

  it("keeps public beer and venue reads open", () => {
    assert.ok(
      rules.includes("isPublicDoc()"),
      "Expected public document check for beers/venues"
    );
  });
});

describe("storage.rules", () => {
  const rules = readRules("storage.rules");

  it("allows public reads", () => {
    assert.ok(
      rules.includes("allow read: if true"),
      "Expected public read permission for Storage objects"
    );
  });

  it("requires admin custom claim for writes", () => {
    assert.ok(
      rules.includes("request.auth.token.admin == true"),
      "Expected admin claim check for Storage writes"
    );
  });

  it("cross-checks the acting user's active adminUsers record in Firestore", () => {
    assert.ok(
      rules.includes("firestore.get("),
      "Expected cross-service firestore.get() in Storage rules"
    );
    assert.ok(
      rules.includes("adminUsers/$(request.auth.uid)"),
      "Expected Storage rules to look up the acting user's adminUsers record"
    );
    assert.ok(
      rules.includes("record.status == 'active'"),
      "Expected an active-status check on the adminUsers record"
    );
    assert.ok(
      rules.includes("record.role == request.auth.token.role"),
      "Expected role agreement between record and token claims"
    );
  });

  it("does not contain the legacy hard-coded admin email list", () => {
    const legacyEmails = [
      "chadnuttall1@gmail.com",
      "chad@seasaba.com",
      "katy@seasaba.com",
      "knuttall05@gmail.com",
      "timschwenck@gmail.com",
    ];
    for (const email of legacyEmails) {
      assert.strictEqual(
        rules.includes(email),
        false,
        `storage.rules still contains legacy email: ${email}`
      );
    }
  });
});
