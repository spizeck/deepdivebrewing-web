import { describe, it } from "node:test";
import assert from "node:assert";
import type { QboEntityNotification } from "@/lib/qbo-protocol";
import { installQboDbMock, withEnv } from "./qbo-test-helpers";

const firestore = installQboDbMock();
const ENV = { QBO_ENVIRONMENT: "sandbox" };
const CONNECTION = "qboConnections/sandbox";
const RECEIPTS = "qboWebhookReceipts";

const notification: QboEntityNotification = {
  realmId: "realm-1",
  entityName: "Customer",
  entityId: "42",
  operation: "Create",
  lastUpdated: "2026-01-05T12:00:00Z",
};

function connectionDoc(status: string) {
  return { environment: "sandbox", status, realmId: "realm-1" };
}

function receipts() {
  return [...firestore.docs.entries()]
    .filter(([path]) => path.startsWith(`${RECEIPTS}/`))
    .map(([, data]) => data);
}

async function record(
  notifications: QboEntityNotification[] = [notification]
) {
  const { recordQboWebhookNotifications } = await import("@/lib/qbo-webhook");
  return withEnv(ENV, () =>
    recordQboWebhookNotifications(notifications, "req-1")
  );
}

describe("recordQboWebhookNotifications realm recognition", () => {
  it("marks a receipt realmKnown when it matches the connected realm", async () => {
    firestore.reset({ [CONNECTION]: connectionDoc("connected") });
    const outcome = await record();

    assert.deepStrictEqual(outcome, {
      received: 1,
      recorded: 1,
      duplicates: 0,
      ignoredRealms: 0,
    });
    assert.strictEqual(receipts()[0]?.realmKnown, true);
  });

  it("does not treat a disconnected record's stored realm as known", async () => {
    firestore.reset({ [CONNECTION]: connectionDoc("disconnected") });
    const outcome = await record();

    assert.deepStrictEqual(outcome, {
      received: 1,
      recorded: 1,
      duplicates: 0,
      ignoredRealms: 1,
    });
    assert.strictEqual(receipts()[0]?.realmKnown, false);
  });

  it("does not treat a reauthorization_required record's realm as known", async () => {
    firestore.reset({
      [CONNECTION]: connectionDoc("reauthorization_required"),
    });
    const outcome = await record();

    assert.strictEqual(outcome.ignoredRealms, 1);
    assert.strictEqual(receipts()[0]?.realmKnown, false);
  });

  it("flags notifications for a different realm as ignored", async () => {
    firestore.reset({ [CONNECTION]: connectionDoc("connected") });
    const outcome = await record([
      { ...notification, realmId: "realm-other" },
    ]);

    assert.strictEqual(outcome.ignoredRealms, 1);
    assert.strictEqual(receipts()[0]?.realmKnown, false);
  });

  it("propagates a realm lookup failure instead of stamping realmKnown:false", async () => {
    firestore.reset({ [CONNECTION]: connectionDoc("connected") });
    firestore.failGet.add("qboConnections/sandbox");
    try {
      await assert.rejects(record());
      // No receipt may be written — a swallowed failure would otherwise
      // dedupe the delivery forever with realmKnown:false.
      assert.strictEqual(receipts().length, 0);
    } finally {
      firestore.failGet.clear();
    }
  });
});

describe("recordQboWebhookNotifications dedupe", () => {
  it("deduplicates a replayed delivery", async () => {
    firestore.reset({ [CONNECTION]: connectionDoc("connected") });

    const first = await record();
    assert.strictEqual(first.recorded, 1);
    assert.strictEqual(first.duplicates, 0);

    const second = await record();
    assert.deepStrictEqual(second, {
      received: 1,
      recorded: 0,
      duplicates: 1,
      ignoredRealms: 0,
    });
    assert.strictEqual(receipts().length, 1);
  });
});
