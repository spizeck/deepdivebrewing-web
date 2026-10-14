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
        expectedFingerprint: FINGERPRINT,
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
      expectedFingerprint: FINGERPRINT,
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
    const before = JSON.stringify(store.get(PROPOSAL_ID));
    const result = await decidePayoutProposal({
      proposalId: PROPOSAL_ID,
      action: "approve",
      expectedFingerprint: FINGERPRINT,
      actor: ACTOR,
    });
    assert.equal(result.changed, false);
    assert.equal(result.status, "approved");
    // An exact replay must not touch the stored decision or audit trail.
    assert.equal(JSON.stringify(store.get(PROPOSAL_ID)), before);
  });

  it("requires the fingerprint that was actually reviewed", async () => {
    seedProposal();
    accountingMode = "approval";
    const { decidePayoutProposal } = await import(
      "@/lib/stripe-payout-decisions"
    );
    // Missing entirely — a client that never rendered the facts.
    await assert.rejects(
      decidePayoutProposal({
        proposalId: PROPOSAL_ID,
        action: "approve",
        expectedFingerprint: "",
        actor: ACTOR,
      }),
      /fingerprint/i
    );
    // Stale UI: the proposal was rebuilt between render and click.
    await assert.rejects(
      decidePayoutProposal({
        proposalId: PROPOSAL_ID,
        action: "approve",
        expectedFingerprint: "kind|99999|USD|different|facts",
        actor: ACTOR,
      }),
      /material facts changed/i
    );
    assert.equal(store.get(PROPOSAL_ID)!.status, "proposed");
  });

  it("refuses decisions for proposals with no material fingerprint", async () => {
    // Legacy docs predate fingerprint binding — deciding would bind the
    // approval to nothing.
    seedProposal({ materialFingerprint: undefined });
    accountingMode = "approval";
    const { decidePayoutProposal } = await import(
      "@/lib/stripe-payout-decisions"
    );
    await assert.rejects(
      decidePayoutProposal({
        proposalId: PROPOSAL_ID,
        action: "approve",
        expectedFingerprint: FINGERPRINT,
        actor: ACTOR,
      }),
      /fingerprint binding/i
    );
  });

  it("keeps the superseded decision's action and fingerprint in history", async () => {
    seedProposal();
    accountingMode = "approval";
    const { decidePayoutProposal } = await import(
      "@/lib/stripe-payout-decisions"
    );
    await decidePayoutProposal({
      proposalId: PROPOSAL_ID,
      action: "approve",
      expectedFingerprint: FINGERPRINT,
      actor: ACTOR,
    });
    await decidePayoutProposal({
      proposalId: PROPOSAL_ID,
      action: "reject",
      note: "wrong payment",
      expectedFingerprint: FINGERPRINT,
      actor: { uid: "admin-2" },
    });
    const doc = store.get(PROPOSAL_ID)!;
    const decisions = doc.decisions as FakeDoc[];
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].action, "approve");
    assert.equal(decisions[0].fingerprint, FINGERPRINT);
    assert.equal(decisions[1].action, "reject");
    const trail = doc.auditTrail as FakeDoc[];
    assert.ok(
      (trail[trail.length - 1].note as string).includes(
        "supersedes prior approve"
      )
    );
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
      expectedFingerprint: FINGERPRINT,
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
      expectedFingerprint: FINGERPRINT,
      actor: ACTOR,
    });
    assert.equal(withdrawn.status, "rejected");
    assert.equal(store.get(PROPOSAL_ID)!.status, "rejected");
  });

  it("refuses withdrawal while an apply holds a live claim lease", async () => {
    accountingMode = "approval";
    const { decidePayoutProposal } = await import(
      "@/lib/stripe-payout-decisions"
    );
    // A claimed, in-flight apply is past the decision checkpoint — the
    // executor may already be posting. Withdrawing now would let the
    // entry land and then read as rejected.
    seedProposal({
      status: "approved",
      decision: {
        action: "approve",
        actorUid: "admin-1",
        at: "t0",
        fingerprint: FINGERPRINT,
      },
      execution: {
        state: "in_progress",
        attempts: 1,
        leaseUntilMs: Date.now() + 60_000,
      },
    });
    await assert.rejects(
      decidePayoutProposal({
        proposalId: PROPOSAL_ID,
        action: "reject",
        expectedFingerprint: FINGERPRINT,
        actor: ACTOR,
      }),
      /apply is in progress/i
    );
    assert.equal(store.get(PROPOSAL_ID)!.status, "approved");

    // An expired lease means the claim stalled — withdrawal is safe.
    store.set(PROPOSAL_ID, {
      ...store.get(PROPOSAL_ID)!,
      execution: {
        state: "in_progress",
        attempts: 1,
        leaseUntilMs: Date.now() - 1,
      },
    });
    const withdrawn = await decidePayoutProposal({
      proposalId: PROPOSAL_ID,
      action: "reject",
      expectedFingerprint: FINGERPRINT,
      actor: ACTOR,
    });
    assert.equal(withdrawn.status, "rejected");
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
          expectedFingerprint: FINGERPRINT,
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
        expectedFingerprint: FINGERPRINT,
        actor: ACTOR,
      }),
      /not found/i
    );
    store.clear();
    await assert.rejects(
      decidePayoutProposal({
        proposalId: PROPOSAL_ID,
        action: "approve",
        expectedFingerprint: FINGERPRINT,
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
        expectedFingerprint: FINGERPRINT,
        actor: ACTOR,
      }),
      /proposalId/
    );
  });
});
