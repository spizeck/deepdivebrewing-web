# Financial Architecture Simplification Audit

**Date:** 2026-10-17 · **Scope:** Stripe payment collection, QuickBooks
Online (QBO) integration, Ollie POS (via Stripe/Spreedly), payout and
reconciliation automation, and the surrounding operational machinery.
**Status:** investigation only — no accounting behavior changes are proposed
for immediate implementation; each item lists its own gate.

> **Revision (2026-10-19 follow-up):** the owner has clarified that
> **automatic payout accounting is a mandatory business requirement** —
> manual monthly journal entries are explicitly rejected. The original
> audit's "retire the dormant execution layer / human posts in QBO"
> recommendation is therefore **rescinded**. Sections 6–9 are revised to a
> **commissioning plan**: keep and prove the existing proposal/executor
> machinery, simplify only what weakens nothing, and activate through a
> controlled pilot. The factual findings (§§1–5) are unchanged — the code
> and its dormancy claims are still accurate; what changed is the verdict
> about what to do with it.

## Executive summary

The codebase carries **~15,400 lines of financial `lib/` modules, ~1,100
lines of API routes, ~4,100 lines of admin UI, and ~15,800 lines of
financial tests** — roughly 36,000 lines in total. About half of it is
justified and doing real work every day (the payments tool, the Stripe
webhook, the QBO connection, and the Sales Receipt sync). The other half is
a **payout-accounting automation platform** built across PRs #223–#239
(2026-10-13 → 2026-10-15) that has **never executed a write in production**:
production runs `STRIPE_ACCOUNTING_MODE=observe`, so the decisions route,
the guarded executor, the apply route, and `automatic` mode all refuse by
construction.

**The single most important finding:** nearly all of the exotic complexity
(confidence-tiered Ollie matching, Spreedly two-leg identity verification,
fingerprint-bound approvals, execution leases, uncertain-state recovery,
cutover/historical proposal variants) exists because **one Stripe account
carries two businesses' flows** — DDB web payments and Ollie/Spreedly
wholesale — so payouts are mixed-source and every generic tool (native
Stripe→QBO connectors included) would double-count the Ollie lane. The
pipeline exists to answer "which balance transactions in this payout are
ours, which are Ollie's, and what should be booked?" That *question* is
genuinely hard and the ledger that answers it is worth keeping. ~~The
machinery that acts on the answer is the overbuild~~ — **revised:** the
machinery that acts on the answer (approve → apply → auto-apply) is the
automation the owner requires. Its cost is real, but its safety controls
(fingerprint-bound approvals, claim leases, apply-time revalidation,
marker adoption, `uncertain` states) are exactly what permit unattended
writes without risking duplicate or mis-directed postings. The remaining
problem is *proof*: it has never executed against a live or sandbox QBO
company, so commissioning — not removal — is the path.

**Recommended direction (revised): commission the existing automation.**
The desired steady state is: Stripe settles → payout ledger classifies →
verified proposals post to QBO unattended → the owner is interrupted only
for genuine exceptions. The execution layer the original audit proposed
deleting is now the asset: its safety model (fingerprint-bound approvals,
claim leases, apply-time revalidation, marker adoption, `uncertain`
states) is *the* thing that makes unattended posting defensible. The
correct move is to **validate and activate it through a controlled pilot**,
not to remove it. What can still be simplified: the dead QBO webhook path
(F6), the duplicated recon pipeline (F5), and any orchestration that does
not protect the automatic write path. Independently, the accountant must
approve the clearing-account convention the executor implements
(reclassifying Ollie payments out of Undeposited Funds) — that is an
accounting-policy decision, not a code decision.

---

## 1. Current architecture

```
                        ┌──────────────────────────┐
                        │        Stripe acct        │  SHARED:
                        │  (DDB web + Ollie via     │  mixed-source payouts
                        │   Spreedly gateway)       │
                        └───────┬──────────┬────────┘
              checkout.session.*│          │payout.* lifecycle
                                ▼          ▼
                    ┌───────────────────────────────┐
                    │  POST /api/webhooks/stripe    │  signature verify,
                    │  (payments-admin.ts)          │  stripeEvents dedupe
                    └───────┬───────────────┬───────┘
                            │               │ after() → ledger build
            canonical       ▼               ▼
            re-fetch  ┌───────────┐   ┌──────────────────────────┐
            + dedupe  │ payments  │   │ stripePayouts/{id}       │
            + txn     │ {id} paid │   │ + qboAccountingProposals │ observe-only
                      └─────┬─────┘   │ (processStripePayoutLedger)│ in prod
                            │         │  · lane classify          │
              in-commit     │         │  · Ollie match tiers      │
              enqueue +     ▼         │  · 3 proposal kinds       │
              inline write┌──────────────────────────────────────┐
                          │ qboSyncRecords (durable queue)       │
                          │ claim lease + backoff + needs_attention
                          └──────────┬───────────────────────────┘
                                     │ POST /v3/.../salesreceipt
                                     ▼
                        ┌──────────────────────────┐     ┌────────────────┐
                        │   QuickBooks Online      │◄────│ Ollie → QBO    │
                        │  · SalesReceipt (gross → │     │ (invoices +    │
                        │    Stripe Balance for    │     │  payments to   │
                        │    card, cash acct for   │     │  Undeposited   │
                        │    cash rail)            │     │  Funds, method │
                        │  · clearing/fee/transfer │     │  "Cash")       │
                        │    proposals: NEVER POST │     │  — native, no  │
                        │    in production         │     │  DDB code      │
                        └──────────────────────────┘     └────────────────┘
   ┌─────────────────────────────────────────────────────────────────┐
   │ Recovery/oversight: Vercel cron /api/cron/qbo-sweep (daily) —     │
   │ missed-enqueue recovery + due-record processing + payout-ledger   │
   │ re-scan (35d). Admin: mapping UI, sync status + retry, recon      │
   │ report (read-only), payout panel (proposals; decisions/apply      │
   │ refuse in observe). QBO webhook → qboWebhookReceipts (stored,     │
   │ never consumed).                                                 │
   └─────────────────────────────────────────────────────────────────┘
```

### Flow A — DDB card payment → QBO (the live path)

1. Staff creates a payment in `/admin/payments`
   (`createAdminPayment`, `lib/payments-admin.ts`): durable
   `payments/{clientRequestId}` record + event in a transaction, then one
   Stripe Checkout Session (`idempotencyKey: paymentId`, card rail only).
2. Customer pays on the hosted page. `checkout.session.completed` →
   webhook verifies signature, dedupes on `stripeEvents/{eventId}`,
   re-fetches the session canonically, reconciles the stored snapshot
   (mismatch → quarantine), commits `paid` + the `qboSyncRecords` doc **in
   the same Firestore transaction**, then enriches receipt/card display.
3. `postPaidPaymentToQbo` attempts the write inline: re-verify canonical
   session, mapping gate (fail closed on any missing required field),
   marker lookup (`ddb:<paymentId>` PrivateNote scan on the generic
   customer's receipts for that `TxnDate` — adoption, never duplication),
   then `POST /salesreceipt` (gross, `paidAt` date, mapped clearing
   account, mapped income item by purpose, `GlobalTaxCalculation`
   semantics per company country).
4. Failures land in `failed` (6-step backoff → `needs_attention` after 8
   attempts) or `needs_attention` immediately for non-retryable causes.
   The daily cron sweep retries due records and re-enqueues settled
   payments that somehow lack a record (72 h window). Admin can requeue
   manually (`/api/admin/quickbooks/sync/retry`).

**The cash rail** (#206) shares the same seam: `cash_payment` sync record,
same worker, different deposit account/payment method, no provider calls.

### Flow B — Ollie POS transaction

Ollie creates the QBO Invoice + Payment itself (deposits to **Undeposited
Funds**, `PaymentMethodRef` = "Cash" regardless of the real rail) and
collects the money through Spreedly into **the same Stripe account** —
charge metadata carries `connect_agent: "Spreedly"` and a composite
`order_id` (`<order>-<paymentRef>`). DDB code does nothing until the
payout arrives; then the ledger tries to attribute each Ollie charge to a
QBO payment (see Flow C). **Historically these payments were treated as
cash in the books** — the current design wants to reclassify them to the
Stripe clearing account, which is a *choice*, not a requirement (see §5,
Ollie lane).

### Flow C — Stripe payout

1. `payout.*` webhook → `recordStripePayoutEvent`: dedupe + canonical
   payout fetch + `stripePayouts/{id}` status doc, all inside the request;
   `after()` runs `processStripePayoutLedger`.
2. The build fetches the payout's balance transactions (bounded pages),
   builds the DDB identity index from `payments`, scans QBO Undeposited
   Funds payments in a −45/+7-day window, resolves linked invoice
   DocNumbers, then classifies every movement:
   `ddb` (positive app identity) / `ollie` (match confidence
   `verified`/`suggested`/`ambiguous`/`unmatched`, incl. Spreedly
   composite-identity two-leg verification and customer-name demotion
   rules) / `external` / `account_level` (fees, adjustments, the payout's
   own debit).
3. It persists deterministic **proposals**: `move_payment_to_clearing`
   (Ollie payment UF→Stripe Balance), `stripe_fee_expense` (JE: fee
   expense / clearing), `payout_transfer` (clearing→mapped payout
   account). Proposals are fingerprinted; decisions bind to the
   fingerprint; `autoEligible` marks the narrow set `automatic` mode may
   self-approve; `STRIPE_AUTOMATION_CUTOVER` splits eligible vs
   `historical` proposals.
4. **In production (observe) this stops at step 3.** Decisions refuse,
   apply refuses, the automatic sweep refuses. The payout panel is a
   read-only worklist + discrepancy report (`ddb_receipt_unposted`,
   ambiguous matches, foreign currency, unreconciled state).

### Flow D — reconciliation report (manual)

`POST /api/admin/quickbooks/reconciliation` → `runQboReconciliation`
(`lib/qbo-recon.ts`): a *windowed* (≤180 days) read-only scan — Stripe
balance transactions + totals, `payments` identity scan, charge/refund
enrichment (budget 40), QBO clearing/fee account balances and
existing-entry scan — that reports a clearing difference and findings
flags. Persisted snapshot `qboReconState/{env}`.

## 2. Inventory of custom infrastructure

| Subsystem | Files | ~LOC (impl) | Role |
| --- | --- | --- | --- |
| Payment tool (records, state machine, checkout spec, refund pipeline) | `lib/payments-common.ts` (1889), `lib/payments-admin.ts` (1321) | 3,210 | Core revenue collection |
| Stripe client + config | `lib/stripe.ts`, `lib/stripe-config.ts`, `lib/stripe-balance.ts` | ~620 | Provider reads + env policy |
| Stripe webhook endpoint | `app/api/webhooks/stripe/route.ts` + handlers | ~97 + in payments-admin | Settlement authority |
| QBO foundation | `lib/qbo.ts`, `qbo-tokens.ts`, `qbo-crypto.ts`, `qbo-config.ts`, `qbo-protocol.ts` (OAuth/query/canonicalization parts), `qbo-api.ts`, `qbo-errors.ts`, `qbo-common.ts`, `qbo-callback-cookie.ts`, `qbo-mapping.ts` | ~4,400 | OAuth, encrypted tokens, API client, mapping |
| Sales Receipt sync | `lib/qbo-sync.ts` (933), `lib/qbo-sweep.ts` (312), `lib/qbo-sync-admin.ts` (209), sync + retry + cron routes | ~1,600 | The only production write path |
| Reconciliation report | `lib/qbo-recon.ts` (439), `lib/qbo-recon-common.ts` (704), recon route, `admin-quickbooks-recon.tsx` (416) | ~1,650 | Read-only windowed report |
| Payout pipeline | `lib/stripe-payouts.ts` (1950), `lib/stripe-payouts-common.ts` (1766), payout + sync routes, `admin-quickbooks-payouts.tsx` (1111) | ~5,100 | Observe-mode ledger + proposals |
| Proposal **decisions** | `lib/stripe-payout-decisions.ts` (263), proposals route | ~380 | Approve/reject, fingerprint-bound — **dormant** |
| Proposal **executor** | `lib/stripe-payout-executor.ts` (821), apply route | ~910 | Guarded QBO writer — **dormant** |
| QBO webhook | `app/api/webhooks/quickbooks/route.ts` (68), `lib/qbo-webhook.ts` (127) | ~195 | Stores dedupe receipts — **no consumer** |
| Admin accounting UI | `admin-quickbooks-workspace.tsx` (634), `admin-quickbooks-mapping.tsx` (410), summary, pages | ~1,100 | Operations surface |
| Financial tests | `tests/lib/stripe-payout*.test.ts` (~5,900), `qbo-*`/`payments-*` (~9,900), api tests | ~15,800 | — |
| Collections | `payments`, `payments/events`, `stripeEvents`, `qboConnections`, `qboOauthStates`, `qboWebhookReceipts`, `qboConfig`, `qboSyncRecords`, `qboSweepState`, `qboReconState`, `stripePayouts`, `qboAccountingProposals` | 12 stores | all deny-all to clients |
| Env surface | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_ACCOUNTING_MODE`, `STRIPE_AUTOMATION_CUTOVER`, `QBO_ENVIRONMENT`, `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, `QBO_WEBHOOK_VERIFIER_TOKEN`, `QBO_TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `QBO_SWEEP_LOOKBACK_HOURS` | 12 vars | — |

## 3. Findings — what is justified vs. overbuilt

### Justified (this is the skeleton to keep)

- **The payments tool and webhook settlement path.** Idempotent create,
  canonical re-fetch, snapshot quarantine, terminal-state machine,
  claim-based refund pipeline. This is real payment-safety work on a real
  money surface; proportional.
- **QBO foundation** (OAuth one-time state, AES-256-GCM token storage,
  single token-acquisition point with refresh lease, normalized error
  taxonomy, environment isolation). Required for any write and correctly
  scoped.
- **Durable sync record + worker** (`lib/qbo-sync.ts`). The in-commit
  enqueue, deterministic `env:sourceType:sourceId` identity, claim lease,
  and marker-based adoption are exactly the right pattern for a provider
  with no idempotency keys. The 6-step backoff → `needs_attention`
  escalation is simple and correct.
- **The daily cron sweep** — cheap, bounded recovery; at this volume it
  will almost always no-op, which is the point.
- **Mapping config + live entity validation** — required to post safely;
  fail-closed on incomplete config is the right gate.
- **Payout ingestion + ledger classification (observe)** — this is the
  discrepancy-visibility requirement made real: `ddb_receipt_unposted`
  catches a settled DDB payment whose Sales Receipt can't be proven; lane
  attribution tells the operator what a mixed payout contains. Worth
  keeping — *as a report*.

### Overbuilt / disproportional (the audit's core findings)

> **Revision:** under the mandatory-automation requirement, F1–F4 remain
> accurate *descriptions* — but the verdict flips from "remove" to
> **"commission and validate"**. The execution layer is the deliverable,
> not the overbuild; what was disproportionate is that it was built to an
> unattended-execution standard and never activated. F5–F6 still identify
> genuine removable/mergeable code.

**F1. The proposal execution layer is a dormant write path.**
`stripe-payout-decisions.ts` (fingerprint-bound approve/reject,
`expectedFingerprint` conflict semantics, `confirmQboPaymentId`),
`stripe-payout-executor.ts` (claim lease, apply-time revalidation,
marker+legs recovery scan, `uncertain` state, adoption), the apply and
decision routes, and the decision UI in `admin-quickbooks-payouts.tsx` —
~1,300 implementation lines plus ~1,700 lines of dedicated tests plus UI —
implement the three QBO writes the owner wants posted automatically.
Production has *never* armed it (`observe` refuses it end to end). It is
simultaneously the highest-risk code in the repo (the only path that can
mutate the books beyond Sales Receipts) and the least exercised — so the
risk is *unproven* execution, not the existence of the path. The
commissioning plan (§8) supplies the missing evidence through a real
sandbox/approval-mode pilot before `automatic` is enabled.

**F2. `automatic` mode was built before the pilot that would justify it.**
Self-approving `autoEligible` proposals, `pendingAutoApply` retry
scheduling, automation-recorded approvals that lapse on rebuild — all
shipped (#232) while production sits in `observe`. Speculative generality:
the correctness bar for unattended bookkeeping was engineered for a volume
and a confidence level the business hasn't reached.

**F3. Cutover + historical-proposal machinery.** `STRIPE_AUTOMATION_CUTOVER`,
`:historical` proposal variants, `-HIST` marker namespaces, suppression of
historical proposals by existing entries, manual-only enforcement — built
to handle a backlog migration that is a one-time event. ~Several
hundred lines inside `stripe-payouts*.ts`. **Revised:** keep until the
pre-cutover backlog is settled — it is what prevents a legacy payout from
auto-posting against already-reconciled books — then remove in C6.

**F4. The Ollie matching engine exceeds what the *decision* needs.**
Verified-tier matching requires: namespaced identifier extraction from
charge metadata/description, linked-invoice DocNumber resolution, the
Spreedly composite `order_id` two-leg corroboration (both legs must agree
on the same candidate), PaymentRefNum targeted lookups, cross-payout claim
pools, and customer-name demotion with a carved-out exception for fully
corroborated Spreedly matches. ~~This is forensic-accounting-grade
matching to produce a `verified` badge whose only consumer is
`autoEligible` — the path that never runs.~~ **Revised:** `verified` is
the only tier that gates unattended writes, so under the
mandatory-automation requirement the forensic matching *is* the safety
control — it is what keeps amount/date collisions (e.g. two same-price
Ollie payments in one payout) from misfiling revenue. Keep it; the
simplification is that `suggested`/`ambiguous`/`unmatched` need no
execution path — they are already exception lanes.

**F5. Two parallel reconciliation pipelines.** `qbo-recon.ts` (windowed
report) and `stripe-payouts.ts` (per-payout ledger) independently list
Stripe balance transactions, build a DDB identity index, classify
movements, and enrich unattributed charges — overlapping implementations
of the same idea (`resolveChargeAttribution` vs. the payout lane
classifier), ~1,650 + ~5,100 lines. The payout ledger is the richer,
more actionable one; the recon report's distinct value is only the
clearing-balance difference and the "are fees already booked" inspection.

**F6. QBO webhook receipts are a dead end.** Verified, deduplicated,
persisted — and read by nothing. The comment says future sync consumes
them; the sync that shipped queries QBO directly instead. ~400 lines
(endpoint + module + tests + rules + indexes) of write-only storage.

**F7. Distributed-lease proliferation.** Five distinct lease/fencing
mechanisms: sync-record claim lease, token-refresh lease, sweep cursor
CAS, payout-sync owner lease, executor claim lease. Each is locally
correct (Firestore has no other concurrency primitive and QBO writes
must not duplicate), but the pattern count signals a job-orchestration
platform built on a document store. Keeping the *sales-receipt* leases is
required; the payout-side leases mostly exist to protect the dormant
executor.

**F8. Error/state surface area exceeds operating scale.** Sync statuses
× ~15 `needs_attention` reason codes; proposal statuses
(`proposed/blocked/approved/rejected/applied/stale`) × execution states
(`in_progress/applied/failed/refused/uncertain`) × confidence tiers ×
lanes × scopes. Each individual state is defensible; the cartesian product
is sized for a payments-ops team, not a brewery.

### Proportional but worth noting

- The `payments` record + events subcollection + refund claim pipeline —
  the audit trail is a feature, keep.
- `charge.refunded` is *not* subscribed — dashboard refunds are invisible
  until the payout ledger surfaces them as exceptions (a real, if delayed,
  detection path). #180 remains the explicit gap.
- Refund reversal posting is not implemented: a `refunded` payment's gross
  Sales Receipt stays in the books until a human posts a RefundReceipt.
  Documented manual procedure exists for cash; the same should apply to
  card until #180 ships.

## 4. Native alternatives — evaluated honestly

| Alternative | What it actually does | Fit for DDB |
| --- | --- | --- |
| **Stripe Connector by QuickBooks** (Intuit's own app, free) | Auto-imports Stripe sales, refunds, fees, payouts → QBO; maps products→items; can match imported txns to existing QBO records | **Blocked by the shared account**: it imports *every* Stripe transaction — including Ollie/Spreedly charges that Ollie already books as invoices+payments → duplicate revenue. Becomes viable **only if DDB's web payments move to a dedicated Stripe account**. Caveats: CW (non-US) company support unverified; ad-hoc Checkout `price_data` items map weakly; introduces a second writer whose posting model (its own receipts + deposit) would collide with the current clearing model unless the custom sync is fully retired. |
| **QBO bank feed + match** | Deposits arriving at the bank match against UF payments / clearing transfers; "make deposits" handles batched settlement natively | **Keep as the manual fallback for exceptions only** — not the target architecture. Under the mandatory-automation requirement the executor performs the UF→clearing moves and transfers itself; the bank feed remains the human tool for the exception lane and for pre-cutover history. If the accountant prefers the UF-native model (§5) this row becomes the posting mechanism and the executor's reclassification proposals are retired instead. |
| **Ollie → QBO integration** | Already creates invoices + payments; owns wholesale revenue end-to-end | Keep as-is. **Open question:** can Ollie's integration be configured to deposit payments to the Stripe clearing account (or another account) instead of UF? If yes, `move_payment_to_clearing` proposals lose their reason to exist. |
| **Stripe payout reconciliation report** (Dashboard CSV) | Per-payout itemization of charges/fees/refunds | Feeds a monthly fee JE with zero code; the accountant's existing tool for the same numbers the pipeline computes. |
| **Synder / A2X / Acodei etc.** ($20–80/mo) | Per-transaction or summarized payout sync | Same shared-account double-counting risk; adds vendor cost and a parallel posting model. Not recommended. |
| **Vercel cron** | Already used for the daily sweep | Correct tool; nothing to change. |

## 5. The Ollie question (required careful examination)

The user flagged: *Ollie payments have historically been represented as
cash in QBO.* Verified in code + docs: Ollie's own sync writes
`PaymentMethodRef = Cash` and deposits to Undeposited Funds; the books
reconciled payouts against those UF payments (bank feed / manual).

The current design's `move_payment_to_clearing` proposal exists to
reclassify those payments into `Stripe Balance` so a single
clearing→bank transfer covers each payout. **But reclassification is not
the only correct model.** A mixed payout can settle two legs natively:
the Ollie share matched from UF (deposit match), the DDB share as a
clearing→bank transfer. That preserves the historical UF convention,
removes the write that touches Ollie's own records (the riskiest proposal
kind — it mutates a Payment Ollie created), and demotes the elaborate
verified-tier matching from *execution prerequisite* to *reporting aid*.

This is a modeling decision for the accountant — both models are correct.
The honest trade-off under the mandatory-automation requirement:

- **Clearing model (implemented):** the executor does the UF→clearing
  moves, the fee JE, and the transfer — fully automatic for verified
  payouts, but it reclassifies records Ollie created.
- **UF-native model:** simpler QBO footprint and no writes to Ollie's
  records, but the Ollie leg reconciles via the bank feed — meaning either
  *manual* matching per payout (which contradicts the automation
  requirement) or a different, unbuilt automation path.

**Default: proceed with the implemented clearing model unless the
accountant objects** — switching to UF-native is new build, not a
simplification of what exists. This decision is listed in §12 and is a
precondition for production activation.

## 6. Recommended minimum viable architecture — REVISED (automated)

```
Stripe Checkout → payments record → webhook settle → Sales Receipt
(gross → clearing)                                    [KEEP — auto-write 1]
Cash payment        → same record → Sales Receipt (→ cash acct)   [KEEP]
Ollie → QBO invoices+payments (UF)  — Ollie's own integration     [KEEP, untouched]
Payout webhook → ledger + classification + proposals              [KEEP]
  ├─ move_payment_to_clearing (verified Ollie matches → auto)     [COMMISSION]
  ├─ stripe_fee_expense JE (actual fees; auto when fully          [COMMISSION]
  │   identified) — otherwise manual approval
  ├─ payout_transfer clearing→bank (auto when fully identified)   [COMMISSION]
  └─ exceptions → admin attention queue (ambiguous, unmatched,    [KEEP]
      refunds, foreign currency, unposted receipts)
Cron sweep: missed-enqueue + due records + payout re-scan +
  pendingAutoApply retry                                          [KEEP]
Recon report → fold unique value (clearing-balance diff) into the
  payout view or keep as the monthly-close check                  [SIMPLIFY later]
Refunds: ledger surfaces them as exceptions; posting stays manual
  until #180                                                      [DEFER posting]
```

The automation boundary, as implemented, is already the right one:
**automatic** = every charge-side movement in the payout positively
identified (DDB `confirmed` or `verified` Ollie), ledger complete and
balanced, eligible scope only. **Exception** = suggested-only matches,
ambiguous/unmatched lines, refunds, foreign currency, account-level
movements — proposals stay manual and a human approves each in the admin
panel. Unattended execution never happens on a partially-understood
payout.

The activation sequence and its gates live in the revised §8 and the
payout-automation ops doc.

## 7. Keep / Simplify / Replace / Remove / Defer matrix

| Component | Verdict | Rationale |
| --- | --- | --- |
| Payments tool (records, state machine, checkout, refunds) | **KEEP** | Core product + correct safety model |
| Stripe webhook (signature, dedupe, canonical re-fetch, quarantine) | **KEEP** | Settlement authority; required |
| QBO OAuth/token/crypto/connection layer | **KEEP** | Required for any write; correctly built |
| Mapping config + entity validation | **KEEP** | Posting safety gate |
| Sync queue + worker + backoff + marker adoption | **KEEP** | Prevents lost/duplicate receipts; right pattern |
| Daily sweep cron | **KEEP** | Bounded recovery, near-zero cost |
| Sync admin panel (counts, retry) | **KEEP** | The one ops surface that matters |
| Payout ingestion + ledger + lane classification | **KEEP** | Discrepancy visibility + the evidence base automatic posting stands on |
| Computed proposals (3 kinds, deterministic ids, persisted) | **KEEP** | The review artifact AND the executor's unit of work; persistence makes decisions auditable and rebuilds idempotent |
| `suggested`-tier Ollie matching | **KEEP** | The manual-review tier — feeds proposals a human confirms |
| `verified` tier: Spreedly two-leg, DocNumber resolution, name-demotion rules | **KEEP** | Now load-bearing: it is the ONLY identity evidence that qualifies a move for unattended execution |
| Fingerprint-bound decisions (`stripe-payout-decisions.ts`, proposals route) | **KEEP** | Required for the manual exception path *and* the approval-mode pilot that precedes automatic |
| Guarded executor (`stripe-payout-executor.ts`, apply route) | **KEEP + VALIDATE** | The automatic write path itself; needs controlled pilot evidence before `automatic`, not removal |
| `automatic` mode + `autoEligible` + `pendingAutoApply` | **KEEP + COMMISSION** | The business goal. `autoEligible`'s gating (fully-identified, balanced, in-scope) is appropriately conservative — see validation |
| Cutover/historical proposal machinery | **KEEP (for now)** | Required by the executor's own gate (no cutover → execution refuses) and by backlog handling at activation. Revisit *after* the pre-automation backlog is cleared — it is a candidate for removal once history is settled |
| `STRIPE_ACCOUNTING_MODE` / `STRIPE_AUTOMATION_CUTOVER` env surface | **KEEP** | The activation gate — deliberately retained as the safety switch |
| Windowed recon report (`qbo-recon*`) | **SIMPLIFY/MERGE (defer)** | Keep as the period-close check during early automation; consolidation into the payout view is a *later* cleanup, not an activation gate |
| QBO webhook + receipts collection | **REMOVE** | No consumer; unsubscribing at Intuit + deleting the route/storage removes ~400 lines |
| Refund posting (RefundReceipt) — #180 | **DEFER** | Refunds surface as ledger exceptions today; manual procedure acceptable at this volume |
| Tax posting config — #184 | **DEFER (accountant gate)** | Mechanism ready; activation pending answers |
| Chargeback/dispute posting | **DEFER** | Classification+exception visibility already exists; posting manual |
| Stripe-account separation for Ollie vs web | **REPLACE (business change, not code)** | If Ollie can settle to a dedicated Stripe account, the mixed-source problem disappears and the matching machinery becomes a much simpler DDB-only reconciliation |

## 8. Prioritized sequence — REVISED (commission, then simplify)

Ordered by what must happen before `automatic` can be trusted, then by
maintenance savings:

**C0 — validation groundwork (no production behavior change)** — done on
the commissioning branch: representative-scenario tests through the
ledger→proposal pipeline; focused fixes for gaps found during review
(e.g. manual-cover suppression now surfaces an `existing_manual_entry`
exception instead of skipping silently); removal of the dead QBO webhook
path.

**C1 — accounting decisions (owner + accountant, no code)**
Approve: the Stripe-clearing convention for Ollie payments
(`move_payment_to_clearing` reclassifies Ollie's UF payments — the
alternative UF-native model is a different proposal kind that does not
exist today), the payout-account mapping (bank vs Payouts in Transit —
`stripePayoutAccountId`), the fee expense account, and the tax position
(#184). Without the clearing-convention sign-off, `verified` moves must
stay manual.

**C2 — configuration + pilot under `approval` mode**
Complete the account mapping (clearing / fee / payout destination), set
`STRIPE_AUTOMATION_CUTOVER` to a date after which all payouts are known
clean, set `STRIPE_ACCOUNTING_MODE=approval`. Then: run the manual payout
sync for a few recent real payouts; review each computed proposal in the
admin panel; approve and apply the ones that are correct; verify the
resulting QBO entries by hand (move → JE → transfer). This is the only
way to gain real-world evidence the executor posts correctly — it has
**never** written to a live or sandbox company.

**C3 — settle the backlog, then enable `automatic`**
Once the approval-mode pilot shows the three writes landing correctly and
the pre-cutover historical proposals are resolved (approve-and-apply or
reject), set `STRIPE_ACCOUNTING_MODE=automatic`. First payouts under
automatic: check the QBO entries against the payout ledger after each one
for the first few weeks; the exceptions list + `pendingAutoApply` retries
cover transient failures.

**S1 — remove QBO webhook receipts** — S (done on the commissioning
branch): dead-end write-only storage, ~400 lines removed.

**S2 — consolidate the recon report** — M (deferred, post-activation):
fold clearing-balance diff into the payout view; retire or shrink
`qbo-recon*` (~1,650 lines). Not an activation gate.

**S3 — retire cutover/historical machinery** — S (deferred): once every
pre-automation payout is reconciled and no `historical` proposals remain,
the historical variants and `-HIST` marker namespace can be deleted.

## 9. Estimated reduction — REVISED

| Change | Lines affected (approx.) | Notes |
| --- | --- | --- |
| S1 QBO webhook receipts | ~400 removed | dead-end storage |
| S2 recon consolidation (later) | ~1,200–1,650 removed | one reconciliation surface |
| S3 cutover/historical retirement (after backlog settles) | ~several hundred | inside `stripe-payouts*.ts` |
| C0 commissioning fixes/tests | +small net | scenario tests add lines; the fixes prevent silent gaps |
| **Realistic total reduction** | **~1,600–2,500 (now), ~2,000–3,000 (after backlog)** | vs the ~6–8.5k the manual model would have freed |

The honest trade-off: automation keeps ~3–4k more lines than the manual
model would have, but those lines *earn their keep* — they are the
difference between "posting unattended" and "owner does monthly
bookkeeping," which is the stated goal. The right maintenance metric
under automation is not lines but **proven execution**: an executor that
has posted correctly for weeks is cheaper to keep than a dormant one was
to delete.

## 10. Financial-correctness safeguards — REVISED (what automation relies on)

- Sales-Receipt dedupe (`env:source:sourceId` durable record + `ddb:`
  marker adoption) — untouched.
- Positive DDB identity for posting; Ollie lane writes go only through
  `move_payment_to_clearing` on `verified` identity — `suggested` tier
  never executes unattended.
- Webhook signature verification, canonical re-fetch, snapshot
  quarantine — untouched.
- `needs_attention` / proposal-exception human-review paths — untouched
  and load-bearing: they are the exception surface automatic mode routes
  around, not through.
- Automatic-path hard gates, all enforced in code and unit-tested:
  `autoEligible` requires a complete, balanced, single-currency,
  fully-identified eligible ledger; `move` auto-eligibility requires
  `verified` identity; aggregate writes require synced DDB receipts
  (`ddb_gross_unposted`); approvals bind to a material fingerprint;
  claims are leased; writes are revalidated at apply time; unknown write
  outcomes park as `uncertain` and reconcile by marker before retrying;
  pre-cutover dates and `historical` proposals refuse unattended
  execution.
- Audit trail (`payments/events`, proposal `decisions[]`/`auditTrail`,
  admin audit log) preserved — every automated action is recorded with
  actor `automation`.
- Mode semantics: `observe` refuses every write; `approval` requires a
  human decision; `automatic` self-approves only `autoEligible`
  proposals. The mode flag is the kill switch — set it back to `observe`
  and the executor refuses everything instantly.

## 11. Where "simpler" would introduce accounting errors (explicit)

- **Deleting the sync queue** in favor of fire-and-forget posting → lost
  or duplicated receipts on transient failures. Not recommended.
- **Trusting webhook payloads** for amounts → corrupted records. Kept:
  canonical re-fetch everywhere.
- **A generic Stripe→QBO connector on the shared account** → double-books
  Ollie wholesale revenue. Explicitly rejected unless the Stripe account
  is split.
- **Auto-matching Ollie payments by amount/date alone for *writes*** →
  wrong-payment reclassification. The implemented model agrees: only
  `verified` (identifier-corroborated) matches are `autoEligible`;
  `suggested` stays review-grade forever.
- **Removing the fingerprint/lease/uncertain machinery from the
  executor** → a write path that can't prove what it approved, can't
  exclude concurrent writers, and can't distinguish "posted" from
  "maybe posted." Those controls are the reason automation is defensible.
- **Posting net instead of gross** (or letting a connector do summarized
  entries) → loses per-purpose income detail (tours vs tastings) the
  business reports on.
- **Estimating fees** → wrong expense; actuals come from balance
  transactions/payout report only.
- **Aggregates posting before DDB receipts** → clearing outflows with no
  proven inflow; the `ddb_gross_unposted` refusal exists for exactly this.

## 12. Decisions requiring owner / accountant input — REVISED

1. **Clearing convention for Ollie payments** (activation blocker): the
   executor reclassifies Ollie's UF payments into the Stripe clearing
   account so one transfer settles each payout. Approve this convention,
   or say UF-native is required — the latter is a *different proposal
   kind that does not exist* and would be new build. Related: can Ollie's
   QBO integration target clearing at write time? If yes, move proposals
   become unnecessary entirely.
2. **Payout destination** (`stripePayoutAccountId`): the bank account
   Stripe settles into, or a "Payouts in Transit" clearing account —
   accountant's call; the mapping supports either.
3. **Fee expense account** (`stripeFeeExpenseAccountId`): which QBO
   expense account carries Stripe fees.
4. **Cutover date**: the first date after which all payouts are clean for
   automation — everything earlier posts only through the manual
   historical path.
5. **Refund gap (#180)**: refunds surface as exceptions; posting a
   reversal stays manual. Acceptable at this volume, or build the
   RefundReceipt sync?
6. **Tax (#184)** — unchanged; still awaiting the accountant's answers.
   (Not an activation blocker for payout posting itself — it gates
   receipt tax treatment, a separate decision.)
7. **Shared Stripe account** — still the highest-leverage simplification:
   a dedicated DDB Stripe account would make the mixed-source matching
   machinery unnecessary. Worth asking Ollie, but not blocking.
8. **QBO webhook receipts**: removed in the commissioning branch; if the
   Intuit app still has a webhook subscription, unsubscribe it there.

---

*Audit performed read-only against `main` (post-#239). No Stripe/QBO API
writes, no production mutations, no accounting changes. Verified against:
`docs/architecture/quickbooks-accounting-sync.md`,
`docs/operations/quickbooks.md`, `docs/operations/payments.md`,
`docs/TECHNICAL.md` §11, `lib/qbo-*.ts`, `lib/stripe-*.ts`,
`lib/payments-*.ts`, `app/api/admin/quickbooks/*`, `app/api/webhooks/*`,
`vercel.json`, `firestore.rules`, and git history (#161, #178–#184, #206,
#223–#239). Revised 2026-10-19 to reflect the owner's mandatory-automation
requirement: §§6–12 now describe commissioning the existing executor
rather than retiring it.*
