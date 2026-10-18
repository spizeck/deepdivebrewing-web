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

**The $50 Stripe minimum balance:** payouts carry
`payout_minimum_balance_hold` and `payout_minimum_balance_release`
lines — intra-Stripe reserve shifts that explain why the paid amount
differs from charge nets. They are classified as account-level
movements, never proposed as revenue/fees/refunds/transfers, and are
exempt from the identity gate so they don't block an otherwise fully
identified payout. A residual they don't explain still fails the
balance check and keeps the payout manual; any *other* unrecognized
account-level movement does the same.

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

## 2. Sandbox pilot — prove the provider boundary first

Before touching production, exercise the executor against a **QBO sandbox
company** with **Stripe test mode** payouts. This is the missing evidence:
the executor has only ever run against mocked provider calls.

### Environment

Use a **Vercel preview deployment** (or `next dev`) — never the
production deployment. Set on the preview environment:

- `QBO_ENVIRONMENT=sandbox` plus the Intuit app's **development** keys
  (`QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` — development keys can only ever
  talk to sandbox companies, which is itself a safety property),
  `QBO_TOKEN_ENCRYPTION_KEY` (any fresh 32-byte key), and
  `QBO_REDIRECT_URI=https://<preview-host>/api/admin/quickbooks/callback`
  — register that exact URL in the Intuit app first.
- Stripe **test** keys (`sk_test_…`). A registered test webhook is
  optional — **Sync recent payouts** covers ingestion.
- `STRIPE_ACCOUNTING_MODE=approval`,
  `STRIPE_AUTOMATION_CUTOVER=<a date before today>`.

Sharing the production Firebase project is safe *except for one caveat*:
connection docs are per-environment (`qboConnections/sandbox`), sync
records are `sandbox:*`-namespaced, and test payments carry
`livemode:false` — **but** the accounting-mapping document is a single
slot bound to environment + realmId, so saving the sandbox mapping
invalidates the production one until it is re-saved. That fails closed
(production is in `observe`, so a missing mapping only *blocks*
proposals) — still, either re-enter the production mapping when the
pilot ends or run the preview against a separate Firebase project.

### Fixture recipe

- **Ollie lane (`verified`):** in the sandbox company create a Customer
  → Invoice whose DocNumber carries `Order <orderNum>` (e.g.
  `Ollie Order 91001`) → receive a Payment with
  `PaymentRefNum=<paymentNum>` (e.g. `55007`), deposited to
  **Undeposited Funds**. In Stripe test mode, create a PaymentIntent for
  the same amount, then set the **Charge's** metadata —
  `connect_agent=Spreedly`, `order_id=<orderNum>-<paymentNum>` — because
  the matcher reads `charge.metadata`, not PaymentIntent metadata
  (`stripe charges update <ch_…> -d "metadata[connect_agent]=Spreedly" -d "metadata[order_id]=<orderNum>-<paymentNum>"`).
  Both legs of the composite must corroborate the same QBO payment for
  `verified`.
- **DDB lane (optional for a first pilot):** run a real checkout through
  the preview's payments tool — it produces a `livemode:false` payment
  record and a Sales Receipt in the sandbox company via the normal sync.
- **Payout:** once the test charges settle into test balance, create the
  payout (`stripe payouts create --amount <net> --currency usd`) or wait
  for the scheduled test payout; test payouts can take ~a business day to
  reach `paid`. Then **Sync recent payouts** on the preview admin.

### What to verify

1. The ledger classifies the fixture charge as Ollie `verified`; the
   move + fee JE + transfer proposals are `autoEligible`.
2. Approve + apply; in the **sandbox** company confirm: the Payment's
   `DepositToAccountRef` is now the clearing account, the JournalEntry
   carries actual fees and the `DDB-PAYOUT-FEE:po_…` marker, the
   Transfer carries `DDB-PAYOUT-TRANSFER:po_…`.
3. Re-run **Sync recent payouts** — proposals are unchanged
   (deterministic ids) and nothing double-posts.
4. A charge with no metadata and no matching QBO payment lands as
   `unmatched` — proposals stay manual, exception listed.
5. `uncertain` outcomes are unit-tested (executor tests) but can't be
   forced without fault injection — watch the logs for
   `stripe.payout.apply_*` events instead; that gap is acceptable for
   the pilot.

## 3. Production pilot — `approval` mode

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

**Do not skip to automatic before step 5 verifies real QBO writes** —
and do not start this pilot until the sandbox pilot (§2) has already
proven the provider boundary. (Status as of 2026-10: the production
approval-mode pilot is already done — ~35 proposals applied to the live
company with correct entries. Remaining gate: the reserve-movement
exemption and attention notifications, then the env flip.)

## 4. Backlog

- Pre-cutover payouts classify but only produce `historical` proposals —
  approve-and-apply each by hand, or post by hand and let
  `detectExistingCover` suppress them. Either way, every live proposal
  must reach a decided state (`applied`/`rejected`) before automatic is
  enabled; a stale `approved` proposal cannot execute once its
  fingerprint no longer binds, but an undecided backlog pollutes the
  exception surface.

## 5. Go automatic

1. Set `STRIPE_ACCOUNTING_MODE=automatic` (Vercel env, redeploy).
2. On the next paid payout, `autoEligible` proposals self-approve and
   apply inside the same ledger build; failures mark
   `pendingAutoApply` and the daily sweep retries them.
3. **First weeks:** after each payout settles, spot-check the QBO
   entries against the payout card. Verify clearing carries no
   unexplained residual (the recon report's clearing-balance diff is
   the period-close check for this).

## 6. Exceptions — what interrupts you

The admin payout panel's exceptions list is the attention queue:
ambiguous/unmatched movements, foreign currency, unposted DDB receipts
(`ddb_receipt_unposted`), conflicting QBO state
(`reconciled_state_conflict`), suppressed-by-manual-entry detections
(`existing_manual_entry`), and `uncertain` execution outcomes. Each
names the movement and the reason; the fix is to investigate, then
approve/reject the proposal or correct the QBO record. Exceptions never
post silently.

**Notification:** under `automatic` mode, each payout needing attention
sends one email to `PAYOUT_ATTENTION_EMAIL` (falling back to the staff
notification mailbox) naming the payout, amount, exception codes, how
many proposals already applied, and the admin link. The email is deduped
by a signature of the payout's exception set stored on the payout doc —
an unchanged problem never re-sends; `cutover_skipped` (expected
pre-automation history) never notifies. A send failure logs
`stripe.payout.attention_notify_failed` and does not affect processing.

## 7. Disable / rollback

- **Instant kill switch:** `STRIPE_ACCOUNTING_MODE=observe` — the
  executor refuses every write, ingestion keeps running.
- **Partial outage:** `failed`/`uncertain` executions are retried by
  the sweep (`pendingAutoApply`); an uncertain write reconciles by
  marker before retrying — it cannot double-post.
- **Wrong entry posted:** reverse it in QBO, reject the proposal, fix
  the mapping/decision that produced it. The proposal's `auditTrail`
  and `decisions[]` record exactly what the system believed.

## 8. Monitoring (first ~month)

- Weekly: scan the payout panel exceptions for any payout that didn't
  fully reconcile.
- Monthly close: run the reconciliation report — the clearing-balance
  diff against Stripe should explain itself through in-transit payouts
  only.
- Watch for `stripe.payout.auto_apply_failed` /
  `qbo.sweep.*` log lines in Vercel.
