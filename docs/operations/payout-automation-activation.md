# Stripe Payout Accounting Automation — Activation Runbook

How to take the payout ledger from `observe` to `automatic` safely.
This is a checklist, not a deployment plan — nothing below requires a
new release, only configuration changes and careful observation.

**Background:** [quickbooks.md](quickbooks.md) covers the QBO
integration and the payout ledger mechanics. The accounting model and
the safety properties the executor enforces are documented in the
financial-architecture audit (`docs/architecture/financial-simplification-audit.md`,
PR #241 — §6 model, §10 safeguards).

## What "automatic" posts

For every `paid` Stripe payout whose ledger is complete, balanced, and
fully identified, three kinds of entries post to QuickBooks unattended:

| Entry | Posting | Auto condition |
| --- | --- | --- |
| `move_payment_to_clearing` | Ollie Payment reclassified Undeposited Funds → Stripe clearing | Line matched at `verified` tier only (identifier-corroborated, never amount/date alone) |
| `stripe_fee_expense` | JournalEntry: DR fee expense / CR clearing, for the payout's **actual** Stripe fees | Every charge-side movement positively identified (DDB `confirmed` or `verified` Ollie) |
| `payout_transfer` | Transfer clearing → payout account for the full paid amount | Same as above, plus payout status `paid` |

Anything less certain — `suggested`-only Ollie matches, ambiguous or
unmatched movements, refunds, foreign currency, account-level
adjustments — keeps the whole payout's proposals manual and surfaces as
an exception in the admin payout panel. Unattended execution never
happens on a partially-understood payout.

## 1. Preconditions

### Accounting decisions (owner + accountant — gates, not code)

- [ ] **Clearing convention approved.** The executor reclassifies
  Ollie's QBO payments out of Undeposited Funds into the Stripe
  clearing account so a single transfer settles each payout. If the
  accountant requires leaving Ollie payments in UF, stop — that model
  is not implemented and enabling automatic would post against the
  wrong convention.
- [ ] **Payout destination chosen** — the bank account Stripe settles
  into, or a "Payouts in Transit" account the accountant clears against
  the bank feed. Encoded as `stripePayoutAccountId` in the mapping.
- [ ] **Fee expense account chosen** (`stripeFeeExpenseAccountId`).
- [ ] **Refund handling understood**: refunds surface as payout
  exceptions; their reversal entries stay manual until #180 is decided.

### Configuration

- [ ] Accounting mapping complete in `/admin/integrations/quickbooks`
  (clearing, fee, payout destination plus the receipt fields).
- [ ] `STRIPE_AUTOMATION_CUTOVER=YYYY-MM-DD` set — the first date after
  which every payout is known clean. Everything earlier is classified
  but only ever posts through the manual `historical` path.
- [ ] QBO connection healthy (Test connection), no `needs_attention`
  sync records outstanding.

## 2. Pilot — `approval` mode

1. Set `STRIPE_ACCOUNTING_MODE=approval` (Vercel env, redeploy).
2. In the payout panel, run **Sync recent payouts** to ingest the last
   ~35 days.
3. For each paid payout, review the computed proposals. Compare against
   Stripe Dashboard → the payout's balance transactions.
4. Approve and apply one low-risk payout's proposals (a DDB-only or
   fully-verified payout is the best first candidate — fee JE +
   transfer only).
5. Verify the resulting QBO entries by hand: the Payment's
   `DepositToAccountRef`, the JournalEntry legs and marker
   (`DDB-PAYOUT-FEE:po_…`), the Transfer amount/accounts and marker
   (`DDB-PAYOUT-TRANSFER:po_…`).
6. Repeat until the three write kinds have each landed correctly at
   least once on real data.

**Do not skip to automatic before step 5 verifies real QBO writes.** The
executor has only ever run against mocks — the pilot is what proves the
provider boundary.

## 3. Backlog

- Pre-cutover payouts classify but only produce `historical` proposals —
  approve-and-apply each by hand, or post by hand and let
  `detectExistingCover` suppress them. Either way, every live proposal
  must reach a decided state (`applied`/`rejected`) before automatic is
  enabled; a stale `approved` proposal cannot execute once its
  fingerprint no longer binds, but an undecided backlog pollutes the
  exception surface.

## 4. Go automatic

1. Set `STRIPE_ACCOUNTING_MODE=automatic` (Vercel env, redeploy).
2. On the next paid payout, `autoEligible` proposals self-approve and
   apply inside the same ledger build; failures mark
   `pendingAutoApply` and the daily sweep retries them.
3. **First weeks:** after each payout settles, spot-check the QBO
   entries against the payout card. Verify clearing carries no
   unexplained residual (the recon report's clearing-balance diff is
   the period-close check for this).

## 5. Exceptions — what interrupts you

The admin payout panel's exceptions list is the attention queue:
ambiguous/unmatched movements, foreign currency, unposted DDB receipts
(`ddb_receipt_unposted`), conflicting QBO state
(`reconciled_state_conflict`), suppressed-by-manual-entry detections
(`existing_manual_entry`), and `uncertain` execution outcomes. Each
names the movement and the reason; the fix is to investigate, then
approve/reject the proposal or correct the QBO record. Exceptions never
post silently.

## 6. Disable / rollback

- **Instant kill switch:** `STRIPE_ACCOUNTING_MODE=observe` — the
  executor refuses every write, ingestion keeps running.
- **Partial outage:** `failed`/`uncertain` executions are retried by
  the sweep (`pendingAutoApply`); an uncertain write reconciles by
  marker before retrying — it cannot double-post.
- **Wrong entry posted:** reverse it in QBO, reject the proposal, fix
  the mapping/decision that produced it. The proposal's `auditTrail`
  and `decisions[]` record exactly what the system believed.

## 7. Monitoring (first ~month)

- Weekly: scan the payout panel exceptions for any payout that didn't
  fully reconcile.
- Monthly close: run the reconciliation report — the clearing-balance
  diff against Stripe should explain itself through in-transit payouts
  only.
- Watch for `stripe.payout.auto_apply_failed` /
  `qbo.sweep.*` log lines in Vercel.
