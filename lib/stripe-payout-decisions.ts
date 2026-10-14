import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase-admin-db";
import { getQboEnvironment } from "@/lib/qbo-config";
import { getStripeAccountingMode } from "@/lib/stripe-config";
import { QBO_ACCOUNTING_PROPOSALS_COLLECTION } from "@/lib/stripe-payouts-common";
import { QboError } from "@/lib/qbo-errors";
import type { QboEnvironment } from "@/lib/qbo-common";

// Accounting-proposal decisions (approve / reject). A decision is an
// admin bookkeeping record on the proposal document — never a QuickBooks
// write. The decision binds to the proposal's material fingerprint, so a
// rebuild that changes amount, accounts, payment identity, or evidence
// invalidates the approval automatically (see processStripePayoutLedger).
//
// Mode gate: decisions exist to drive execution, so they are only
// meaningful once the deployment opts into the "approval" workflow (or
// "automatic" mode, where the review-required remainder still needs
// human decisions). "observe" is read-only end to end — a feature flag
// cannot conjure a decision surface that mode never armed.

export type ProposalDecisionAction = "approve" | "reject";

export interface DecideProposalInput {
  proposalId: string;
  action: ProposalDecisionAction;
  /**
   * The material fingerprint the reviewer saw. Required — a decision is
   * only meaningful when bound to the facts that were actually reviewed;
   * a proposal rebuilt since render fails closed with a conflict.
   */
  expectedFingerprint: string;
  note?: string;
  actor: { uid: string; email?: string };
}

export interface DecideProposalResult {
  proposalId: string;
  status: string;
  /** False when the decision was already recorded — idempotent replay. */
  changed: boolean;
}

const PROPOSAL_ID_MAX = 256;
const DECISION_NOTE_MAX = 500;

function proposalRef(proposalId: string) {
  return getFirebaseAdminDb()
    .collection(QBO_ACCOUNTING_PROPOSALS_COLLECTION)
    .doc(proposalId);
}

function modeAllowsDecisions(): boolean {
  const mode = getStripeAccountingMode();
  return mode === "approval" || mode === "automatic";
}

export async function decidePayoutProposal(
  input: DecideProposalInput
): Promise<DecideProposalResult> {
  const proposalId = input.proposalId.trim();
  if (!proposalId || proposalId.length > PROPOSAL_ID_MAX) {
    throw new QboError("A valid proposalId is required.", "validation", 400);
  }
  const expectedFingerprint = input.expectedFingerprint?.trim();
  if (!expectedFingerprint || expectedFingerprint.length > 1024) {
    throw new QboError(
      "A decision must carry the material fingerprint that was reviewed.",
      "validation",
      400
    );
  }
  const note = input.note?.trim().slice(0, DECISION_NOTE_MAX) || undefined;
  const environment: QboEnvironment = getQboEnvironment();

  if (!modeAllowsDecisions()) {
    throw new QboError(
      "Proposal decisions require accounting approval mode — the deployment is in observe mode.",
      "permission_denied",
      409
    );
  }

  const now = new Date().toISOString();
  const ref = proposalRef(proposalId);

  return getFirebaseAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new QboError("Proposal not found.", "validation", 404);
    }
    const data = snap.data() as {
      environment?: string;
      status?: string;
      materialFingerprint?: string;
      decision?: { action?: string; fingerprint?: string };
      decisions?: Record<string, unknown>[];
      auditTrail?: { at: string; actor: string; note: string }[];
    };
    if (data.environment !== environment) {
      throw new QboError("Proposal not found.", "validation", 404);
    }
    // A proposal with no fingerprint predates fingerprint binding — it
    // cannot be decided until a rebuild stamps one. Deciding against ""
    // would bind the approval to nothing.
    const fingerprint = data.materialFingerprint;
    if (typeof fingerprint !== "string" || !fingerprint) {
      throw new QboError(
        "This proposal predates fingerprint binding — wait for the next rebuild before deciding.",
        "validation",
        409
      );
    }
    if (expectedFingerprint !== fingerprint) {
      throw new QboError(
        "The proposal's material facts changed since it was reviewed — reload and re-review before deciding.",
        "validation",
        409
      );
    }
    const prior = data.decision;
    const status = data.status;
    // Idempotent replay: same action, same fingerprint, and the stored
    // status already reflects it.
    const already =
      prior?.action === input.action &&
      prior.fingerprint === fingerprint &&
      status === (input.action === "approve" ? "approved" : "rejected");
    if (already) {
      return {
        proposalId,
        status: status ?? "unknown",
        changed: false,
      };
    }

    if (input.action === "approve") {
      // Approval requires a live, executable proposal — blocked means a
      // mapping is missing (approve it after the mapping lands), and
      // stale/applied are out of scope by definition.
      if (status === "approved") {
        throw new QboError(
          "The proposal was already approved against different material facts — wait for the next rebuild before re-approving.",
          "validation",
          409
        );
      }
      if (status !== "proposed") {
        throw new QboError(
          `Only a live proposed entry can be approved (status is ${status ?? "unknown"}).`,
          "validation",
          409
        );
      }
    } else {
      // Rejection is the terminal "do not post" decision — allowed from
      // any live status so an approved entry can be withdrawn.
      if (status === "rejected" || status === "applied") {
        throw new QboError(
          `The proposal is already ${status}.`,
          "validation",
          409
        );
      }
      if (status === "stale") {
        throw new QboError(
          "A stale proposal is already inert — nothing to reject.",
          "validation",
          409
        );
      }
    }

    const decision = {
      action: input.action,
      actorUid: input.actor.uid,
      ...(input.actor.email ? { actorEmail: input.actor.email } : {}),
      at: now,
      ...(note ? { note } : {}),
      fingerprint,
    };
    const trail = [
      ...(Array.isArray(data.auditTrail) ? data.auditTrail : []),
      {
        at: now,
        actor: input.actor.email ?? input.actor.uid,
        note:
          `${input.action === "approve" ? "approved" : "rejected"}` +
          // A second decision overwrites `decision` — the trail records
          // that it superseded one; `decisions` keeps the prior record's
          // action and fingerprint durably.
          (prior?.action ? ` — supersedes prior ${prior.action}` : "") +
          (note ? ` — ${note}` : ""),
      },
    ].slice(-20);
    tx.update(ref, {
      status: input.action === "approve" ? "approved" : "rejected",
      decision,
      decisions: [
        ...(Array.isArray(data.decisions) ? data.decisions : []),
        decision,
      ].slice(-20),
      auditTrail: trail,
      decidedAt: FieldValue.serverTimestamp(),
    });
    return {
      proposalId,
      status: input.action === "approve" ? "approved" : "rejected",
      changed: true,
    };
  });
}
