import { describe, it } from "node:test";
import assert from "node:assert";
import type { QuickBooksSyncCandidate } from "@/lib/qbo-common";
import { installQboDbMock, withEnv } from "./qbo-test-helpers";

const firestore = installQboDbMock();
const ENV = { QBO_ENVIRONMENT: "sandbox" };
const RECORDS = "qboSyncRecords";

async function enqueue(candidate: QuickBooksSyncCandidate) {
  const { enqueueAccountingTransaction } = await import("@/lib/qbo-sync");
  return withEnv(ENV, () => enqueueAccountingTransaction(candidate));
}

describe("enqueueAccountingTransaction", () => {
  it("persists a candidate whose omitted optional fields are stripped — the write survives Firestore serialization", async () => {
    firestore.reset();
    // Only the required fields — the normalizer leaves every optional key
    // as `undefined`, which the real Firestore serializer rejects.
    const result = await enqueue({
      sourceType: "stripe_payment",
      sourceId: "pay_1",
      amountMinorUnits: 4500,
      currency: "usd",
      transactionDate: "2026-01-05T12:00:00Z",
    });

    assert.strictEqual(result.outcome, "pending");
    assert.strictEqual(result.syncId, "sandbox:stripe_payment:pay_1");
    const doc = firestore.docs.get(
      `${RECORDS}/sandbox:stripe_payment:pay_1`
    );
    assert.ok(doc, "sync record was not created");
    // The persisted candidate contains only concrete values — no key is
    // present with an undefined value.
    assert.deepStrictEqual(doc.candidate, {
      sourceType: "stripe_payment",
      sourceId: "pay_1",
      amountMinorUnits: 4500,
      currency: "USD",
      transactionDate: "2026-01-05T12:00:00Z",
    });
  });

  it("keeps every defined optional field in the persisted candidate", async () => {
    firestore.reset();
    const result = await enqueue({
      sourceType: "stripe_payment",
      sourceId: "pay_2",
      amountMinorUnits: 1200,
      currency: "usd",
      transactionDate: "2026-01-05T12:00:00Z",
      customerName: "Jane Diver",
      purpose: "brewery_tour",
      externalRefs: { paymentIntent: "pi_1" },
      attendeeCount: 4,
    });

    assert.strictEqual(result.outcome, "pending");
    const doc = firestore.docs.get(
      `${RECORDS}/sandbox:stripe_payment:pay_2`
    );
    assert.deepStrictEqual(doc?.candidate, {
      sourceType: "stripe_payment",
      sourceId: "pay_2",
      amountMinorUnits: 1200,
      currency: "USD",
      transactionDate: "2026-01-05T12:00:00Z",
      customerName: "Jane Diver",
      purpose: "brewery_tour",
      externalRefs: { paymentIntent: "pi_1" },
      attendeeCount: 4,
    });
  });

  it("returns duplicate for a replayed source identity and leaves the record untouched", async () => {
    firestore.reset({
      [`${RECORDS}/sandbox:stripe_payment:pay_1`]: {
        syncId: "sandbox:stripe_payment:pay_1",
        status: "synced",
        qboEntityId: "77",
      },
    });
    const result = await enqueue({
      sourceType: "stripe_payment",
      sourceId: "pay_1",
      amountMinorUnits: 4500,
      currency: "usd",
      transactionDate: "2026-01-05T12:00:00Z",
    });

    assert.strictEqual(result.outcome, "duplicate");
    assert.strictEqual(
      firestore.docs.get(`${RECORDS}/sandbox:stripe_payment:pay_1`)?.status,
      "synced"
    );
    assert.strictEqual(
      firestore.docs.get(`${RECORDS}/sandbox:stripe_payment:pay_1`)
        ?.qboEntityId,
      "77"
    );
  });
});
