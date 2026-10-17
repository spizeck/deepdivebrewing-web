# Financial Architecture Simplification Audit

**Date:** 2026-10-17 · **Scope:** Stripe payment collection, QuickBooks
Online (QBO) integration, Ollie POS (via Stripe/Spreedly), payout and
reconciliation automation, and the surrounding operational machinery.
**Status:** investigation only — no accounting behavior changes are proposed
for immediate implementation; each item lists its own gate.

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
genuinely hard and the ledger that answers it is worth keeping. The
*machinery that acts on the answer* (approve → apply → auto-apply) is the
overbuild: at brewery volume (order of a few payouts and a few dozen
charges per month), the proposed entries are a checklist a human can post
in QuickBooks in minutes.

**Recommended direction:** keep the observe-mode ledger as the permanent
discrepancy-detection surface, keep proposals as a computed worklist, and
**retire the dormant execution layer** (decisions, executor, apply route,
`automatic` mode, cutover/historical machinery) rather than continue
maintaining an un-armed write path that a single env var can switch from
"report" to "unattended QuickBooks writer." Independently, ask the
accountant whether Ollie payments even need reclassification — leaving them
in Undeposited Funds and matching the payout in the QBO bank feed is the
native mechanism for exactly this, and removes the business need behind the
most complex matching code in the repo.

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

**F1. The proposal execution layer is a dormant write path.**
`stripe-payout-decisions.ts` (fingerprint-bound approve/reject,
`expectedFingerprint` conflict semantics, `confirmQboPaymentId`),
`stripe-payout-executor.ts` (claim lease, apply-time revalidation,
marker+legs recovery scan, `uncertain` state, adoption), the apply and
decision routes, and the decision UI in `admin-quickbooks-payouts.tsx` —
~1,300 implementation lines plus ~1,700 lines of dedicated tests plus UI —
exist to perform three QBO writes a human can do in minutes per payout.
Production has *never* armed it (`observe` refuses it end to end). It is
simultaneously the highest-risk code in the repo (the only path that can
mutate the books beyond Sales Receipts) and the least exercised.
Every future change to matching or proposals must keep this whole
apparatus consistent or it silently rots — a loaded gun in the repo.

**F2. `automatic` mode was built before the pilot that would justify it.**
Self-approving `autoEligible` proposals, `pendingAutoApply` retry
scheduling, automation-recorded approvals that lapse on rebuild — all
shipped (#232) while production sits in `observe`. Speculative generality:
the correctness bar for unattended bookkeeping was engineered for a volume
and a confidence level the business hasn't reached.

**F3. Cutover + historical-proposal machinery.** `STRIPE_AUTOMATION_CUTOVER`,
`:historical` proposal variants, `-HIST` marker namespaces, suppression of
historical proposals by existing entries, manual-only enforcement — built
to handle a backlog migration that (a) is a one-time event and (b) can be
done by hand in less time than the machinery took to design. ~Several
hundred lines inside `stripe-payouts*.ts`.

**F4. The Ollie matching engine exceeds what the *decision* needs.**
Verified-tier matching requires: namespaced identifier extraction from
charge metadata/description, linked-invoice DocNumber resolution, the
Spreedly composite `order_id` two-leg corroboration (both legs must agree
on the same candidate), PaymentRefNum targeted lookups, cross-payout claim
pools, and customer-name demotion with a carved-out exception for fully
corroborated Spreedly matches. This is forensic-accounting-grade matching
to produce a `verified` badge whose only consumer is `autoEligible` — the
path that never runs. For a human-readable worklist, `suggested` (unique
amount+date+currency candidate) is sufficient evidence; a human confirms
in seconds at this scale.

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
| **QBO bank feed + match** | Deposits arriving at the bank match against UF payments / clearing transfers; "make deposits" handles batched settlement natively | **Strong.** This is the *native* mechanism for everything the proposal layer does: match a payout deposit to Ollie UF payments + clearing withdrawals + fee adjustments. Already partially in use (docs: payouts arrive as transfers involving UF). Zero code. |
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

This is a modeling decision for the accountant — both models are correct;
the UF-native one needs less machinery.

## 6. Recommended minimum viable architecture

```
Stripe Checkout → payments record → webhook settle → Sales Receipt
(gross → clearing)                       [KEEP — the only auto-write]
Cash payment        → same record → Sales Receipt (→ cash acct)   [KEEP]
Ollie → QBO invoices+payments (UF)  — Ollie's own integration     [KEEP, untouched]
Payout webhook → ledger + classification + exception flags        [KEEP as report]
Monthly close (human, ~15 min):  per payout, post JE (fees, actual)
   + transfer clearing→bank / bank-feed match UF payments         [MANUAL, native]
Recon: single report (consolidated ledger view + clearing diff)   [SIMPLIFY to one]
Refunds: document manual RefundReceipt procedure; #180 optional   [DEFER or minimal]
```

In this architecture QuickBooks stays the system of record for money
movement and the app's job narrows to three things: **(1)** book the one
leg nobody else books (DDB gross receipts), **(2)** surface what a payout
contains and flag what doesn't reconcile, **(3)** never block a sale on
any of it.

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
| Payout ingestion + ledger + lane classification (observe) | **KEEP (as report)** | Discrepancy visibility: `ddb_receipt_unposted`, unclassified/external flags, exceptions list |
| Computed proposals (3 kinds, rendered in admin) | **SIMPLIFY** | Keep as *computed-at-render checklist* — drop persistence of the proposal state machine (fingerprints/stale/revival) if no decision machinery remains |
| `suggested`-tier Ollie matching (amount+date+UF) | **SIMPLIFY** | Sufficient for a human worklist |
| `verified` tier: Spreedly two-leg, DocNumber resolution, name-demotion rules | **SIMPLIFY/DEFER** | Only feeds `autoEligible`/apply-time identity — dormant; demote to evidence annotation, not a gate |
| Fingerprint-bound decisions (`stripe-payout-decisions.ts`, proposals route) | **REMOVE** | Exists only to arm execution; never used in prod |
| Guarded executor (`stripe-payout-executor.ts`, apply route) | **REMOVE** | Dormant write path; highest-risk dead code. Correctness is preserved by human execution in QBO |
| `automatic` mode + `autoEligible` + `pendingAutoApply` | **REMOVE** | Speculative unattended bookkeeping; mode flag alone is a risk surface |
| Cutover/historical proposal machinery | **REMOVE** | One-time migration tooling; manual historical handling suffices |
| `STRIPE_ACCOUNTING_MODE` / `STRIPE_AUTOMATION_CUTOVER` env surface | **REMOVE** | Collapses with the execution layer |
| Windowed recon report (`qbo-recon*`) | **SIMPLIFY/MERGE** | Consolidate into the payout-ledger view; keep only clearing-balance diff + fee-booked inspection that the ledger lacks |
| QBO webhook + receipts collection | **REMOVE** | No consumer; unsubscribing at Intuit + deleting the route/storage removes ~400 lines. (Keep endpoint-removed docs note.) |
| Refund posting (RefundReceipt) — #180 | **DEFER** | Manual documented procedure acceptable at this volume; if built, keep minimal (enqueue on `refunded` → mirrored RefundReceipt — pipeline exists) |
| Fee posting (`stripe_fee` dormant vocabulary) | **DEFER** | Monthly accountant JE from Stripe payout report = zero code; revisit only if volume grows |
| Tax posting config — #184 | **DEFER (accountant gate)** | Mechanism ready; activation pending answers |
| Chargeback/dispute posting | **DEFER** | Classification+exception visibility already exists; posting manual |
| Stripe-account separation for Ollie vs web | **REPLACE (business change, not code)** | If Ollie can settle to a dedicated Stripe account (or Ollie's QBO integration can target the clearing account), the mixed-source problem — the root cause of most custom complexity — disappears, and even native connectors become viable |

## 8. Prioritized remediation sequence

Ranked by **maintenance savings ÷ financial risk**:

**P0 — freeze the execution layer (docs/policy, near-zero risk)**
Set `STRIPE_ACCOUNTING_MODE` absent/`observe` permanently; document that
`approval`/`automatic` are retired vocabulary. Cost: trivial. This is the
default already — formalize it.

**P1 — remove the dormant write path (~4–6k lines incl. tests/UI)** — S
Delete `stripe-payout-decisions.ts`, `stripe-payout-executor.ts`, the
proposals/apply/decision routes, `automatic`/`autoEligible`/`pendingAutoApply`
branches, cutover/historical proposal variants, and the decision/apply UI
blocks in `admin-quickbooks-payouts.tsx`. Keep proposal *computation* as a
read-only checklist on the payout card. Effort: medium (surgical deletion +
test pruning). Risk: low — path is unused; all safeguards (sales-receipt
dedupe, sync queue, ledger) unaffected. Rollback: git revert.

**P2 — demote matching tiers (~300–500 lines)** — M
Keep `suggested`/`ambiguous`/`unmatched` display; reduce `verified` to an
evidence label (keep identifier extraction as *displayed evidence*, drop
it as an execution gate — including the executor-specific claim pools and
two-leg promotion if P1 lands). Risk: low; reporting-only. Rollback: revert.

**P3 — consolidate reconciliation surfaces** — M
Fold the windowed recon report's unique value (clearing-balance diff,
existing-entries inspection) into the payout-ledger admin view; retire
`qbo-recon*` (~1,650 lines) or reduce it to a "balances" card. Risk: low —
read-only. Rollback: revert.

**P4 — remove QBO webhook receipts** — S
Unsubscribe in the Intuit portal, delete route + `lib/qbo-webhook.ts` +
`qboWebhookReceipts` rules/tests. Confirm no future plan needs them.
Risk: trivial. Rollback: revert + re-subscribe.

**P5 — bookkeeping-procedure documentation** — S
Write the ops doc for the manual monthly close: where fee totals come
from (Stripe payout report or proposal card), the two-leg payout match
(clearing transfer + UF match), refund reversal procedure (card + cash).
This is what makes "human executes" the designed path rather than tribal
knowledge.

**Deferred items** keep their issues open: #180 (refund posting — decide
manual-forever vs minimal implementation), #184 (tax — accountant gate),
fee posting (monthly JE recommended), `automatic` payout execution
(revisit only if monthly payout count grows ≥10×).

## 9. Estimated reduction

| Change | Lines removed (approx.) | Notes |
| --- | --- | --- |
| P1 execution layer | ~4,000–6,000 (impl + routes + UI + tests) | biggest single win; also removes the only money-mutating surface beyond receipts |
| P2 matching demotion | ~300–600 | shrinks the hardest-to-review logic |
| P3 recon merge | ~1,200–1,650 | one reconciliation pipeline instead of two |
| P4 webhook receipts | ~400 | dead-end storage |
| **Total** | **~6,000–8,500 (~20–25% of the financial subsystem)** | plus retirement of the `approval`/`automatic` risk surface |

Ongoing-maintenance effect: Stripe/QBO API changes, security reviews, and
payout-flow edits stop having to keep a dormant write path consistent;
the remaining surface is reads + one bounded write.

## 10. Financial-correctness safeguards the simplification must preserve

- Sales-Receipt dedupe (`env:source:sourceId` durable record + `ddb:`
  marker adoption) — untouched.
- Positive DDB identity for posting — only `payments/` records post; the
  Ollie lane is *never* written by us (after P1 there is no write that
  could touch it at all).
- Webhook signature verification, canonical re-fetch, snapshot
  quarantine — untouched.
- `needs_attention` human-review path — untouched.
- Ledger/exceptions continue to flag: unposted DDB receipts, ambiguous
  matches, foreign currency, unattributed movements, clearing drift.
- Audit trail (`payments/events`, admin audit log, proposal history as
  computed output) preserved.
- Nothing auto-posts: every QBO mutation beyond the Sales Receipt
  requires a human in QBO — which is *strictly more conservative* than
  the armed modes ever were.

## 11. Where "simpler" would introduce accounting errors (explicit)

- **Deleting the sync queue** in favor of fire-and-forget posting → lost
  or duplicated receipts on transient failures. Not recommended.
- **Trusting webhook payloads** for amounts → corrupted records. Kept:
  canonical re-fetch everywhere.
- **A generic Stripe→QBO connector on the shared account** → double-books
  Ollie wholesale revenue. Explicitly rejected unless the Stripe account
  is split.
- **Auto-matching Ollie payments by amount/date alone for *writes*** →
  wrong-payment reclassification. Mitigated in the recommendation by
  removing writes entirely; suggestions stay review-grade forever.
- **Posting net instead of gross** (or letting a connector do summarized
  entries) → loses per-purpose income detail (tours vs tastings) the
  business reports on.
- **Estimating fees** → wrong expense; actuals come from balance
  transactions/payout report only.

## 12. Decisions requiring owner / accountant input

1. **Shared Stripe account**: can Ollie's Spreedly gateway point at a
   separate/dedicated Stripe account for web payments? (Highest-leverage
   question — eliminates mixed-source payouts entirely.)
2. **Ollie lane model**: reclassify Ollie payments to clearing (current
   design) vs. leave in UF and two-leg match (native)? Also: can Ollie's
   QBO integration target the clearing account at write time?
3. **Execution model**: app-executed proposals (approval mode) vs.
   proposals-as-checklist + human posts in QBO (recommended).
4. **Fee booking**: per-payout JE vs monthly summary JE (recommend
   monthly, from the Stripe report).
5. **Payout destination**: `Stripe Balance` clearing semantics vs bank —
   accountant's call already encoded as `stripePayoutAccountId`.
6. **Refund gap (#180)**: manual procedure acceptable, or build minimal
   RefundReceipt sync?
7. **Tax (#184)** — unchanged; still awaiting the accountant's answers.
8. **QBO webhook receipts**: safe to remove? (No consumer today; confirm
   no planned use.)

---

*Audit performed read-only against `main` (post-#239). No Stripe/QBO API
writes, no production mutations, no accounting changes. Verified against:
`docs/architecture/quickbooks-accounting-sync.md`,
`docs/operations/quickbooks.md`, `docs/operations/payments.md`,
`docs/TECHNICAL.md` §11, `lib/qbo-*.ts`, `lib/stripe-*.ts`,
`lib/payments-*.ts`, `app/api/admin/quickbooks/*`, `app/api/webhooks/*`,
`vercel.json`, `firestore.rules`, and git history (#161, #178–#184, #206,
#223–#239).*
