import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";

// Unit coverage for applyPayoutProposal — the only code path allowed to
// mutate QuickBooks for payout accounting. Firestore, token resolution,
// and every QBO provider call are module-mocked; the tests verify the
// guards (mode, cutover, fingerprint, claim lease), apply-time
// revalidation, provider-side recovery/adoption, and the uncertain →
// reconcile-first retry contract.

mock.module("server-only", { namedExports: {} });

mock.module("firebase-admin/firestore", {
  namedExports: {
    FieldValue: {
      serverTimestamp: () => "__SERVER_TS__",
      delete: () => "__DELETE__",
    },
  },
});

interface FakeDoc {
  [key: string]: unknown;
}
// Keyed by collection name so the executor's payout/sync-record lookups
// stay separate from the proposals collection.
const collections = new Map<string, Map<string, FakeDoc>>();

function collectionDocs(name: string): Map<string, FakeDoc> {
  let m = collections.get(name);
  if (!m) {
    m = new Map();
    collections.set(name, m);
  }
  return m;
}

mock.module("@/lib/firebase-admin-db", {
  namedExports: {
    getFirebaseAdminDb: () => ({
      collection: (name: string) => ({
        doc: (id: string) => ({
          __col: name,
          __id: id,
          get: async () => {
            const doc = collectionDocs(name).get(id);
            return { exists: doc !== undefined, data: () => doc };
          },
        }),
      }),
      runTransaction: async (
        work: (tx: {
          get: (ref: { __col: string; __id: string }) => Promise<{
            exists: boolean;
            data: () => FakeDoc | undefined;
          }>;
          update: (ref: { __col: string; __id: string }, data: FakeDoc) => void;
        }) => Promise<unknown>
      ) =>
        work({
          get: async (ref) => {
            const doc = collectionDocs(ref.__col).get(ref.__id);
            return { exists: doc !== undefined, data: () => doc };
          },
          update: (ref, data) => {
            const docs = collectionDocs(ref.__col);
            docs.set(ref.__id, { ...docs.get(ref.__id), ...data });
          },
        }),
    }),
  },
});

let accountingMode = "approval";
let cutover: string | null = "2026-10-09";
mock.module("@/lib/stripe-config", {
  namedExports: {
    getStripeAccountingMode: () => accountingMode,
    getStripeAutomationCutover: () => cutover,
  },
});
mock.module("@/lib/qbo-config", {
  namedExports: {
    getQboEnvironment: () => "sandbox",
    isQboConfigured: () => true,
  },
});
mock.module("@/lib/qbo-tokens", {
  namedExports: {
    getQuickBooksAccessToken: async () => ({
      accessToken: "tok",
      realmId: "realm-1",
    }),
  },
});
mock.module("@/lib/log", {
  namedExports: {
    logInfo: () => {},
    logWarn: () => {},
    logError: () => {},
  },
});

// --- Provider fakes ---

interface FakePayment {
  id: string;
  syncToken: string;
  totalMinor: number;
  currency?: string;
  depositToAccountId?: string;
}
let payments = new Map<string, FakePayment>();
let ufAccount: { id: string; name: string } | null = { id: "uf-1", name: "UF" };
let reconRows: {
  entityType: string;
  id: string;
  memo?: string;
  legs: { accountId: string; amountMinor: number }[];
}[] = [];
const writeCalls: { op: string; args: FakeDoc }[] = [];
let writeError: Error | null = null;
let readError: Error | null = null;

mock.module("@/lib/qbo-api", {
  namedExports: {
    fetchQboPaymentById: async ({ paymentId }: { paymentId: string }) => {
      if (readError) throw readError;
      const p = payments.get(paymentId);
      return p ? { ...p } : null;
    },
    findQboUndepositedFundsAccount: async () => ufAccount,
    queryQboReconActivity: async ({
      entity,
    }: {
      entity: string;
    }) => {
      if (readError) throw readError;
      return {
        rows: reconRows.filter((r) => r.entityType === entity),
        truncated: false,
      };
    },
    updateQboPaymentDepositAccount: async (args: FakeDoc) => {
      if (writeError) throw writeError;
      writeCalls.push({ op: "payment_update", args });
      const p = payments.get(args.paymentId as string);
      if (p) p.depositToAccountId = args.depositToAccountId as string;
      return { id: args.paymentId, correlationId: "tid-1" };
    },
    createQboJournalEntry: async (args: FakeDoc) => {
      if (writeError) throw writeError;
      writeCalls.push({ op: "journal_create", args });
      return { id: "je-1", correlationId: "tid-2" };
    },
    createQboTransfer: async (args: FakeDoc) => {
      if (writeError) throw writeError;
      writeCalls.push({ op: "transfer_create", args });
      return { id: "tr-1", correlationId: "tid-3" };
    },
  },
});

// --- Fixtures ---

const ACTOR = { uid: "admin-1", email: "admin@example.test" };
const PROPOSALS = "qboAccountingProposals";
const PAYOUTS = "stripePayouts";
const SYNCS = "qboSyncRecords";
const MOVE_ID = "sandbox:po_1:move_payment_to_clearing:900";
const FEE_ID = "sandbox:po_1:stripe_fee_expense:aggregate";
const XFER_ID = "sandbox:po_1:payout_transfer:aggregate";
const FP = "kind|amount|fp";

function seedProposal(id: string, overrides: FakeDoc = {}) {
  const kind = id.includes("move_payment")
    ? "move_payment_to_clearing"
    : id.includes("fee")
      ? "stripe_fee_expense"
      : "payout_transfer";
  collectionDocs(PROPOSALS).set(id, {
    proposalId: id,
    environment: "sandbox",
    payoutId: "po_1",
    kind,
    status: "approved",
    amountMinor: 29401,
    currency: "USD",
    accountingDate: "2026-10-13",
    debit: { accountId: kind === "move_payment_to_clearing" ? "clr-1" : kind === "stripe_fee_expense" ? "fee-1" : "bank-1", label: "x" },
    credit: { accountId: kind === "move_payment_to_clearing" ? undefined : "clr-1", label: "x" },
    stripeRefs: { payoutId: "po_1" },
    qboRefs: kind === "move_payment_to_clearing" ? { paymentId: "900" } : {},
    evidence: ["exact_amount"],
    materialFingerprint: FP,
    decision: { action: "approve", actorUid: "a", at: "t", fingerprint: FP },
    auditTrail: [],
    ...overrides,
  });
}

function seedPayout(lines: FakeDoc[] = []) {
  collectionDocs(PAYOUTS).set("po_1", { payoutId: "po_1", lines });
}

beforeEach(() => {
  collections.clear();
  payments = new Map();
  reconRows = [];
  writeCalls.length = 0;
  writeError = null;
  readError = null;
  accountingMode = "approval";
  cutover = "2026-10-09";
  ufAccount = { id: "uf-1", name: "UF" };
});

describe("applyPayoutProposal — gates", () => {
  it("refuses in observe mode", async () => {
    seedProposal(MOVE_ID);
    accountingMode = "observe";
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    await assert.rejects(
      applyPayoutProposal({ proposalId: MOVE_ID, actor: ACTOR }),
      /observe mode/
    );
    assert.equal(writeCalls.length, 0);
  });

  it("refuses when no cutover is configured", async () => {
    seedProposal(MOVE_ID);
    cutover = null;
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    await assert.rejects(
      applyPayoutProposal({ proposalId: MOVE_ID, actor: ACTOR }),
      /cutover/
    );
  });

  it("answers missing for unknown or foreign proposals", async () => {
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: "sandbox:po_x:k:1",
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "missing");
    seedProposal(MOVE_ID, { environment: "production" });
    const foreign = await applyPayoutProposal({
      proposalId: MOVE_ID,
      actor: ACTOR,
    });
    assert.equal(foreign.apply.outcome, "missing");
  });

  it("refuses non-approved, stale, and fingerprint-mismatched proposals", async () => {
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    for (const status of ["proposed", "blocked", "stale", "rejected"]) {
      seedProposal(MOVE_ID, { status });
      const res = await applyPayoutProposal({
        proposalId: MOVE_ID,
        actor: ACTOR,
      });
      assert.equal(res.apply.outcome, "refused");
      assert.match(
        (res.apply as { reason: string }).reason,
        /proposal_not_approved/
      );
    }
    seedProposal(MOVE_ID, { materialFingerprint: "other" });
    const drift = await applyPayoutProposal({
      proposalId: MOVE_ID,
      actor: ACTOR,
    });
    assert.equal(drift.apply.outcome, "refused");
    assert.match(
      (drift.apply as { reason: string }).reason,
      /fingerprint/
    );
  });

  it("refuses pre-cutover accounting dates", async () => {
    seedProposal(MOVE_ID, { accountingDate: "2026-10-01" });
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: MOVE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "refused");
    assert.match(
      (res.apply as { reason: string }).reason,
      /pre_cutover/
    );
  });
});

describe("applyPayoutProposal — move_payment_to_clearing", () => {
  it("moves a UF payment to clearing after revalidation", async () => {
    seedProposal(MOVE_ID);
    payments.set("900", {
      id: "900",
      syncToken: "3",
      totalMinor: 29401,
      currency: "USD",
      depositToAccountId: "uf-1",
    });
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: MOVE_ID,
      actor: ACTOR,
    });
    assert.deepEqual(res.apply, {
      outcome: "applied",
      qboEntityType: "Payment",
      qboEntityId: "900",
      adopted: false,
    });
    assert.equal(writeCalls.length, 1);
    assert.equal(writeCalls[0].args.syncToken, "3");
    assert.equal(writeCalls[0].args.depositToAccountId, "clr-1");
    const doc = collectionDocs(PROPOSALS).get(MOVE_ID)!;
    assert.equal(doc.status, "applied");
    assert.equal(
      (doc.execution as FakeDoc).qboEntityType,
      "Payment"
    );
  });

  it("adopts a payment already deposited to clearing", async () => {
    seedProposal(MOVE_ID);
    payments.set("900", {
      id: "900",
      syncToken: "3",
      totalMinor: 29401,
      depositToAccountId: "clr-1",
    });
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: MOVE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "applied");
    assert.equal(
      (res.apply as { adopted: boolean }).adopted,
      true
    );
    assert.equal(writeCalls.length, 0);
  });

  it("refuses to move from an unexpected account", async () => {
    seedProposal(MOVE_ID);
    payments.set("900", {
      id: "900",
      syncToken: "3",
      totalMinor: 29401,
      depositToAccountId: "bank-9",
    });
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: MOVE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "refused");
    assert.match(
      (res.apply as { reason: string }).reason,
      /payment_not_in_undeposited/
    );
    assert.equal(writeCalls.length, 0);
  });

  it("refuses when the amount changed since approval", async () => {
    seedProposal(MOVE_ID);
    payments.set("900", {
      id: "900",
      syncToken: "3",
      totalMinor: 999,
      depositToAccountId: "uf-1",
    });
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: MOVE_ID,
      actor: ACTOR,
    });
    assert.match(
      (res.apply as { reason: string }).reason,
      /payment_amount_changed/
    );
  });

  it("reports in_progress while another claim is live", async () => {
    seedProposal(MOVE_ID, {
      execution: {
        state: "in_progress",
        owner: "other-worker",
        leaseUntilMs: Date.now() + 60_000,
        attempts: 1,
      },
    });
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: MOVE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "in_progress");
    assert.equal(writeCalls.length, 0);
  });
});

describe("applyPayoutProposal — aggregate proposals", () => {
  it("creates the fee journal entry with the correlation marker", async () => {
    seedProposal(FEE_ID, { amountMinor: 883 });
    seedPayout([]);
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: FEE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "applied");
    assert.equal(
      (res.apply as { qboEntityType: string }).qboEntityType,
      "JournalEntry"
    );
    const call = writeCalls[0];
    const note = (call.args.payload as FakeDoc).PrivateNote as string;
    assert.ok(note.includes("DDB-PAYOUT-FEE:po_1"));
  });

  it("adopts a landed journal entry instead of duplicating it", async () => {
    seedProposal(FEE_ID, { amountMinor: 883 });
    seedPayout([]);
    reconRows.push({
      entityType: "JournalEntry",
      id: "je-existing",
      memo: "DDB-PAYOUT-FEE:po_1 — prior attempt",
      legs: [
        { accountId: "fee-1", amountMinor: 883 },
        { accountId: "clr-1", amountMinor: -883 },
      ],
    });
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: FEE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "applied");
    assert.equal(
      (res.apply as { qboEntityId: string }).qboEntityId,
      "je-existing"
    );
    assert.equal((res.apply as { adopted: boolean }).adopted, true);
    assert.equal(writeCalls.length, 0);
  });

  it("ignores same-marker entries whose legs do not match", async () => {
    seedProposal(FEE_ID, { amountMinor: 883 });
    seedPayout([]);
    reconRows.push({
      entityType: "JournalEntry",
      id: "je-other",
      memo: "DDB-PAYOUT-FEE:po_1",
      legs: [
        { accountId: "fee-1", amountMinor: 999 },
        { accountId: "clr-1", amountMinor: -999 },
      ],
    });
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: FEE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "applied");
    assert.equal(
      (res.apply as { qboEntityId: string }).qboEntityId,
      "je-1"
    );
  });

  it("creates the payout transfer clearing → payout account", async () => {
    seedProposal(XFER_ID, { amountMinor: 28518 });
    seedPayout([]);
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: XFER_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "applied");
    const payload = writeCalls[0].args.payload as FakeDoc;
    assert.deepEqual(payload.FromAccountRef, { value: "clr-1" });
    assert.deepEqual(payload.ToAccountRef, { value: "bank-1" });
    assert.equal(payload.Amount, 285.18);
    assert.ok(
      (payload.PrivateNote as string).includes("DDB-PAYOUT-XFER:po_1")
    );
  });

  it("refuses aggregate proposals while a DDB gross receipt is unposted", async () => {
    seedProposal(FEE_ID, { amountMinor: 883 });
    seedPayout([
      { lane: "ddb", scope: "eligible", paymentId: "pay-1" },
      { lane: "ollie", scope: "eligible", paymentId: undefined },
    ]);
    // pay-1 has no synced qboSyncRecord.
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: FEE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "refused");
    assert.match(
      (res.apply as { reason: string }).reason,
      /ddb_gross_unposted/
    );
    assert.equal(writeCalls.length, 0);
  });

  it("allows aggregate proposals once every DDB receipt is synced", async () => {
    seedProposal(FEE_ID, { amountMinor: 883 });
    seedPayout([
      { lane: "ddb", scope: "eligible", paymentId: "pay-1" },
    ]);
    collectionDocs(SYNCS).set("sandbox:stripe_payment:pay-1", {
      status: "synced",
      qboEntityId: "sr-1",
    });
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: FEE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "applied");
  });
});

describe("applyPayoutProposal — failure semantics", () => {
  it("marks a write timeout uncertain and reconciles before retry", async () => {
    seedProposal(MOVE_ID);
    payments.set("900", {
      id: "900",
      syncToken: "3",
      totalMinor: 29401,
      depositToAccountId: "uf-1",
    });
    writeError = Object.assign(new Error("timed out"), {
      kind: "unavailable",
    });
    // Use a real QboError so isDefiniteWriteRejection classifies it.
    const { QboError } = await import("@/lib/qbo-errors");
    writeError = new QboError("request timed out", "unavailable");
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: MOVE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "uncertain");
    assert.equal(
      (collectionDocs(PROPOSALS).get(MOVE_ID)!.execution as FakeDoc).state,
      "uncertain"
    );
    assert.equal(collectionDocs(PROPOSALS).get(MOVE_ID)!.status, "approved");

    // Simulate the write having landed despite the timeout: a retry
    // must adopt it, not re-write.
    writeError = null;
    payments.get("900")!.depositToAccountId = "clr-1";
    const retry = await applyPayoutProposal({
      proposalId: MOVE_ID,
      actor: ACTOR,
    });
    assert.equal(retry.apply.outcome, "applied");
    assert.equal((retry.apply as { adopted: boolean }).adopted, true);
    assert.equal(writeCalls.length, 0);
  });

  it("marks a definite provider rejection refused without retry ambiguity", async () => {
    seedProposal(MOVE_ID);
    payments.set("900", {
      id: "900",
      syncToken: "3",
      totalMinor: 29401,
      depositToAccountId: "uf-1",
    });
    const { QboError } = await import("@/lib/qbo-errors");
    writeError = new QboError("stale object", "validation");
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: MOVE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "refused");
  });

  it("fails safely when a provider read fails before any write", async () => {
    seedProposal(FEE_ID, { amountMinor: 883 });
    seedPayout([]);
    const { QboError } = await import("@/lib/qbo-errors");
    readError = new QboError("provider down", "unavailable");
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: FEE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "failed");
    assert.equal(writeCalls.length, 0);
    assert.equal(collectionDocs(PROPOSALS).get(FEE_ID)!.status, "approved");
  });

  it("returns already_applied with the stored entity id", async () => {
    seedProposal(MOVE_ID, {
      status: "applied",
      execution: {
        state: "applied",
        attempts: 1,
        qboEntityType: "Payment",
        qboEntityId: "900",
      },
    });
    const { applyPayoutProposal } = await import(
      "@/lib/stripe-payout-executor"
    );
    const res = await applyPayoutProposal({
      proposalId: MOVE_ID,
      actor: ACTOR,
    });
    assert.equal(res.apply.outcome, "already_applied");
    assert.equal(
      (res.apply as { qboEntityId: string }).qboEntityId,
      "900"
    );
  });
});
