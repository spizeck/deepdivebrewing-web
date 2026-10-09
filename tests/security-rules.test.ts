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

  it("requires a canonical island on venue writes (Issue #134)", () => {
    assert.ok(
      rules.includes(
        "request.resource.data.island in ['saba', 'sxm', 'statia']"
      ),
      "Expected the venue island allowlist on writes"
    );
  });

  it("keeps the QuickBooks credential collections fully server-side (Issue #161)", () => {
    // Each QBO collection must carry its own deny-all — scoped assertions so
    // the catch-all deny can't mask a missing explicit block.
    for (const collection of [
      "qboConnections",
      "qboOauthStates",
      "qboWebhookReceipts",
      "qboConfig",
      "qboSyncRecords",
      "qboSweepState",
    ]) {
      const start = rules.indexOf(`match /${collection}/{docId}`);
      assert.ok(start > -1, `Expected the ${collection} deny-all match`);
      const section = rules.slice(start, start + 200);
      assert.ok(
        section.includes("allow read, write: if false"),
        `Expected ${collection} to deny all client access`
      );
    }
  });

  it("keeps tradeLeads and its subcollections fully server-side (Issues #150, #152)", () => {
    // Scope assertions to the tradeLeads block itself (everything until the
    // next sibling match) so a deny elsewhere in the file can't mask a
    // missing deny here.
    const leadStart = rules.indexOf("match /tradeLeads/{leadId}");
    const leadEnd = rules.indexOf("match /meta/{docId}", leadStart);
    assert.ok(leadStart > -1, "Expected the tradeLeads deny-all match");
    assert.ok(leadEnd > leadStart, "Expected meta match after tradeLeads");
    const leadSection = rules.slice(leadStart, leadEnd);
    assert.ok(
      leadSection.includes("allow read, write: if false"),
      "Expected tradeLeads to deny all client access"
    );
    const activitiesStart = leadSection.indexOf(
      "match /activities/{activityId}"
    );
    assert.ok(
      activitiesStart > -1,
      "Expected the nested tradeLeads activities deny-all match"
    );
    assert.ok(
      leadSection.slice(activitiesStart).includes("allow read, write: if false"),
      "Expected the activities subcollection to deny all client access"
    );
    const communicationsStart = leadSection.indexOf(
      "match /communications/{communicationId}"
    );
    assert.ok(
      communicationsStart > -1,
      "Expected the nested tradeLeads communications deny-all match"
    );
    assert.ok(
      leadSection
        .slice(communicationsStart)
        .includes("allow read, write: if false"),
      "Expected the communications subcollection to deny all client access"
    );
  });

  it("keeps payments, their events, and stripeEvents fully server-side (Issue #155)", () => {
    const paymentsStart = rules.indexOf("match /payments/{paymentId}");
    const stripeEventsStart = rules.indexOf("match /stripeEvents/{eventId}");
    const metaStart = rules.indexOf("match /meta/{docId}");
    assert.ok(paymentsStart > -1, "Expected the payments deny-all match");
    assert.ok(
      stripeEventsStart > paymentsStart,
      "Expected the stripeEvents match after payments"
    );
    assert.ok(metaStart > stripeEventsStart, "Expected meta after stripeEvents");

    const paymentsSection = rules.slice(paymentsStart, stripeEventsStart);
    assert.ok(
      paymentsSection.includes("allow read, write: if false"),
      "Expected payments to deny all client access"
    );
    const eventsStart = paymentsSection.indexOf("match /events/{eventId}");
    assert.ok(eventsStart > -1, "Expected the nested payments events match");
    assert.ok(
      paymentsSection.slice(eventsStart).includes("allow read, write: if false"),
      "Expected the events subcollection to deny all client access"
    );

    const stripeEventsSection = rules.slice(stripeEventsStart, metaStart);
    assert.ok(
      stripeEventsSection.includes("allow read, write: if false"),
      "Expected stripeEvents to deny all client access"
    );
  });

  it("keeps knowledgeArticles and its versions fully server-side (Issue #201)", () => {
    const start = rules.indexOf("match /knowledgeArticles/{articleId}");
    const end = rules.indexOf("match /adminAuditLogs/{logId}", start);
    assert.ok(start > -1, "Expected the knowledgeArticles deny-all match");
    assert.ok(end > start, "Expected adminAuditLogs match after knowledgeArticles");
    const section = rules.slice(start, end);
    assert.ok(
      section.includes("allow read, write: if false"),
      "Expected knowledgeArticles to deny all client access"
    );
    const versionsStart = section.indexOf("match /versions/{versionId}");
    assert.ok(
      versionsStart > -1,
      "Expected the nested versions deny-all match"
    );
    assert.ok(
      section.slice(versionsStart).includes("allow read, write: if false"),
      "Expected the versions subcollection to deny all client access"
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

  it("restricts knowledge/ objects to active admins (Issue #201)", () => {
    const knowledgeStart = rules.indexOf("match /knowledge/{allPaths=**}");
    assert.ok(knowledgeStart > -1, "Expected the knowledge/ match block");
    const section = rules.slice(knowledgeStart, knowledgeStart + 250);
    assert.ok(
      section.includes("allow read, write: if hasActiveAdmin()"),
      "Expected knowledge/ reads and writes gated by hasActiveAdmin()"
    );
    // The public-read rule must carve out the knowledge/ prefix — a blanket
    // catch-all read would re-expose internal attachments to everyone.
    const catchAllStart = rules.indexOf("match /{firstSegment}/{allPaths=**}");
    assert.ok(catchAllStart > -1, "Expected the segmented catch-all block");
    const nextMatch = rules.indexOf("match /", catchAllStart + 10);
    const catchAll = rules.slice(
      catchAllStart,
      nextMatch > -1 ? nextMatch : undefined
    );
    assert.ok(
      catchAll.includes("allow read: if firstSegment != 'knowledge'"),
      "Expected the public-read rule to exclude the knowledge/ prefix"
    );
    assert.ok(
      !catchAll.includes("allow read: if true"),
      "Expected no unconditional public-read on the multi-segment catch-all"
    );
  });
});
