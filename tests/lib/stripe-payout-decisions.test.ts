import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";

// Unit coverage for decidePayoutProposal: the mode gate, status
// transition rules, fingerprint binding, idempotent replay, and audit
// trail appends. Firestore is a minimal in-memory fake; config is mocked
// to a fixed environment and a variable accounting mode.

mock.module("server-only", { namedExports: {} });

mock.module("firebase-admin/firestore", {
  namedExports: {
    FieldValue: { serverTimestamp: () => "__SERVER_TS__" },
  },
});

interface FakeDoc {
  [key: string]: unknown;
}
const store = new Map<string, FakeDoc>();

mock.module("@/lib/firebase-admin-db", {
  namedExports: {
    getFirebaseAdminDb: () => ({
      collection: () => ({
        doc: (id: string) => ({ __id: id }),
      }),
      runTransaction: async (
        work: (tx: {
          get: (ref: { __id: string }) => Promise<{
            exists: boolean;
            data: () => FakeDoc | undefined;
          }>;
          update: (ref: { __id: string }, data: FakeDoc) => void;
        }) => Promise<unknown>
      ) =>
        work({
          get: async (ref) => ({
            exists: store.has(ref.__id),
            data: () => store.get(ref.__id),
          }),
          update: (ref, data) => {
            store.set(ref.__id, { ...store.get(ref.__id), ...data });
          },
        }),
    }),
  },
});

let accountingMode = "observe";
mock.module("@/lib/stripe-config", {
  namedExports: { getStripeAccountingMode: () => accountingMode },
});
mock.module("@/lib/qbo-config", {
  namedExports: { getQboEnvironment: () => "sandbox" },
});

const ACTOR = { uid: "admin-1", email: "admin@example.test" };
const PROPOSAL_ID = "sandbox:po_1:move_payment_to_clearing:42";
const FINGERPRINT = "kind|10000|USD|2026-10-15|dr=34|cr=|ev=exact_amount";

function seedProposal(overrides: FakeDoc = {}) {
  store.set(PROPOSAL_ID, {
    proposalId: PROPOSAL_ID,
    environment: "sandbox",
    payoutId: "po_1",
    kind: "move_payment_to_clearing",
    status: "proposed",
    materialFingerprint: FINGERPRINT,
    auditTrail: [
      { at: "2026-10-15T00:00:00.000Z", actor: "system", note: "computed" },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  store.clear();
  accountingMode = "observe";
});

describe("decidePayoutProposal", () => {
  it("refuses decisions in observe mode", async () => {
    seedProposal();
    const { decidePayoutProposal } = await import(
      "@/lib/stripe-payout-decisions"
    );
    await assert.rejects(
      decidePayoutProposal({
        proposalId: PROPOSAL_ID,
        action: "approve",
        actor: ACTOR,
      }),
      /observe mode/
    );
    assert.equal(store.get(PROPOSAL_ID)!.status, "proposed");
  });

  it("approves a live proposal and binds the fingerprint", async () => {
    seedProposal();
    accountingMode = "approval";
    const { decidePayoutProposal } = await import(
      "@/lib/stripe-payout-decisions"
    );
    const result = await decidePayoutProposal({
      proposalId: PROPOSAL_ID,
      action: "approve",
      note: "matches the Ollie payment",
      actor: ACTOR,
    });
    assert.equal(result.status, "approved");
    assert.equal(result.changed, true);
    const doc = store.get(PROPOSAL_ID)!;
    assert.equal(doc.status, "approved");
    const decision = doc.decision as FakeDoc;
    assert.equal(decision.action, "approve");
    assert.equal(decision.actorUid, "admin-1");
    assert.equal(decision.fingerprint, FINGERPRINT);
    assert.equal(decision.note, "matches the Ollie payment");
    const trail = doc.auditTrail as FakeDoc[];
    assert.equal(trail.length, 2);
    assert.ok((trail[1].note as string).includes("approved"));
  });

  it("replay of the same decision is a no-op", async () => {
    seedProposal({
      status: "approved",
      decision: {
        action: "approve",
        actorUid: "admin-1",
        at: "t0",
        fingerprint: FINGERPRINT,
      },
    });
    accountingMode = "approval";
    const { decidePayoutProposal } = await import(
      "@/lib/stripe-payout-decisions"
    );
    const result = await decidePayoutProposal({
      proposalId: PROPOSAL_ID,
      action: "approve",
      actor: ACTOR,
    });
    assert.equal(result.changed, false);
    assert.equal(result.status, "approved");
  });

  it("rejects a proposal and lets rejection withdraw an approval", async () => {
    seedProposal();
    accountingMode = "approval";
    const { decidePayoutProposal } = await import(
      "@/lib/stripe-payout-decisions"
    );
    const rejected = await decidePayoutProposal({
      proposalId: PROPOSAL_ID,
      action: "reject",
      actor: ACTOR,
    });
    assert.equal(rejected.status, "rejected");

    // Approved → rejected (a withdrawn approval) is also allowed.
    store.set(PROPOSAL_ID, {
      ...store.get(PROPOSAL_ID)!,
      status: "approved",
    });
    const withdrawn = await decidePayoutProposal({
      proposalId: PROPOSAL_ID,
      action: "reject",
      note: "wrong payment",
      actor: ACTOR,
    });
    assert.equal(withdrawn.status, "rejected");
    assert.equal(store.get(PROPOSAL_ID)!.status, "rejected");
  });

  it("refuses to approve blocked, stale, applied, or rejected entries", async () => {
    accountingMode = "approval";
    const { decidePayoutProposal } = await import(
      "@/lib/stripe-payout-decisions"
    );
    for (const status of ["blocked", "stale", "applied", "rejected"]) {
      seedProposal({ status });
      await assert.rejects(
        decidePayoutProposal({
          proposalId: PROPOSAL_ID,
          action: "approve",
          actor: ACTOR,
        }),
        new RegExp(status === "blocked" ? "proposed" : status)
      );
    }
  });

  it("refuses decisions against a foreign environment or missing doc", async () => {
    seedProposal({ environment: "production" });
    accountingMode = "approval";
    const { decidePayoutProposal } = await import(
      "@/lib/stripe-payout-decisions"
    );
    await assert.rejects(
      decidePayoutProposal({
        proposalId: PROPOSAL_ID,
        action: "approve",
        actor: ACTOR,
      }),
      /not found/i
    );
    store.clear();
    await assert.rejects(
      decidePayoutProposal({
        proposalId: PROPOSAL_ID,
        action: "approve",
        actor: ACTOR,
      }),
      /not found/i
    );
  });

  it("validates the proposal id before touching storage", async () => {
    accountingMode = "approval";
    const { decidePayoutProposal } = await import(
      "@/lib/stripe-payout-decisions"
    );
    await assert.rejects(
      decidePayoutProposal({
        proposalId: "   ",
        action: "approve",
        actor: ACTOR,
      }),
      /proposalId/
    );
  });
});
