# QuickBooks Accounting Sync — Design

Design for posting Stripe payment facts into QuickBooks Online without
double-counting money that Stripe/bank activity already represents.
Status: **proposal — pending Chad/accountant review.** No QBO writes are
implemented; this document is the gate for that work.

The connection foundation (OAuth, tokens, webhooks, entity discovery,
mapping, `intuit_tid` capture) is live in production and read-only — see
`../operations/quickbooks.md`. The Stripe payment tool is documented in
`../operations/payments.md`.

## 1. Current state

**Production connection (verified 2026-10-04):** `Deep Dive Brews, BV`,
QBO company country **CW (Curaçao)** — an international, non-US company.
The US-only Intuit sandbox used in development must not shape tax or
account-structure assumptions.

**Firestore evidence (read-only, via admin queries):**

- `qboConnections/production` — connected, healthy, realm bound.
- `qboConfig/accountingMapping` — **does not exist**; all mapping fields
  are unset, as intended.
- `qboSyncRecords` — empty; `enqueueAccountingTransaction()` has never
  been called by a producer.
- `stripeEvents` — real `checkout.session.completed` deliveries applied
  (`toStatus: "paid"`) plus expired sessions ignored. The Stripe payment
  tool is processing real checkout sessions.
- `payments` — currently empty (test records cleaned up).
- `qboWebhookReceipts` — production realm notifications recorded,
  including `Account` updates (the chart of accounts is being actively
  maintained).

**Runtime evidence:** production `qbo.api.entities` logs show successful
one-page discovery runs for `account`, `item`, `customer`, `tax-code` —
the company is small (each entity list under one page of 1000).

**Facts the payment tool captures per settled payment**
(`payments/{id}`, see `lib/payments-common.ts`):

| Fact | Source field | Notes |
| --- | --- | --- |
| Gross amount | `amountMinor` | Integer **USD cents**; currency is fixed `usd` — staff never pick one |
| Purpose | `purpose` | `brewery_tour`, `brewery_tour_tasting`, `additional_guests`, `private_tour`, `other` |
| Description | `description` | Staff-entered, required |
| Customer | `customerName`, `customerEmail` | Email optional |
| Tour context | `tourDate`, `attendeeCount` | Optional hints |
| Stripe ids | `stripeCheckoutSessionId`, `stripePaymentIntentId`, `stripeChargeId`, `stripeCustomerId` | Charge id via post-paid enrichment |
| Receipt | `receiptUrl`, `paymentMethodBrand/last4` | Display facts |
| Settlement time | `paidAt` | Canonical from re-fetched session |
| Internal id | document id = `clientRequestId` | Durable before Stripe ids exist; the idempotency anchor |
| Refund facts | `stripeRefundId`, `refundAmountMinor`, `refundReason`, `stripeRefundStatus` | Full refunds only |

**Facts the payment tool does NOT capture (do not design around them
existing):**

- **Stripe processing fee** — no balance-transaction fetch anywhere;
  `enrichmentFromPaymentIntent` stores receipt URL + card display only.
- **Payout/settlement linkage** — no payout id, no
  `charge.balance_transaction`, no `payout.*` webhook subscription.
- **Partial refunds** — the tool is full-refund-only (1-hour in-app
  window, `REFUND_WINDOW_MS`). Refunds after the window, or partial
  refunds, happen in the **Stripe Dashboard — the app never learns of
  them** (no `charge.refunded` subscription).

## 2. Existing Stripe → QBO behavior — RESOLVED (#178)

The decisive question is answered: see
[Two Stripe lanes](#two-stripe-lanes--the-decisive-finding-178-resolved)
below — an existing Ollie/Spreedly lane books wholesale revenue in QBO,
while DDB-admin payments book nothing. The inspection checklist below is
retained for how the answer was reached and what remains open.

The lane-level revenue question is **resolved** — see the two-lane
finding below: Ollie/Spreedly invoices book wholesale revenue and tax in
QBO, while a proven live DDB-admin payment left no QBO record. How it
was reached: production QBO and Stripe secrets are Vercel `sensitive`
env vars — unretrievable outside production compute — so the books were
inspected manually in the QBO and Stripe UIs.

The remaining checks below cover configuration and payout detail — they
inform mapping choices and the #181/#184 follow-ups, but they do not
re-open the revenue-ownership decision.

**Remaining pre-flight checks (informative, not revenue-gating):**

1. **Apps → My Apps / connected apps** — is there a Stripe integration
   (e.g. "Stripe for QuickBooks", "Synder", "A2X", a custom connector)?
   If yes, what does it create: sales receipts, deposits, journal
   entries, or only bank-feed matches? Screenshot its settings —
   especially which accounts it posts to and whether it books fees.
2. **Chart of Accounts** — is there a Stripe clearing/undeposited-style
   account already in use? Any "Stripe" bank account? A merchant-fees
   expense account? Which income accounts exist for tours/tastings?
3. **Banking → Transactions (bank feed)** — how do Stripe payouts
   arrive? Are they auto-matched to anything? Are fees split out by
   feed rules?
4. **Sales → All Sales** — are there already per-charge sales records
   created by an integration (duplicate rows per Stripe charge, e.g.
   "Stripe sales receipt")? Or is revenue only entered manually/by
   accountant?
5. **A recent Stripe payout** — find one deposit in the bank register
   and look at how it was categorized: gross vs net, what offsetting
   accounts appear, whether a fee expense line exists.
6. **Tax settings** — is the company configured for sales tax / turnover
   tax at all (Curaçao OB regime), and are tour/tasting sales taxable?
   What TaxCodes did discovery return for the prod company?

Items 2–5 already have partial answers from the manual inspection
(`Stripe Balance` clearing account exists; payouts arrive via
Undeposited-Funds transfers and may be mixed-source; fee bookkeeping is
partly manual). Item 6 stays pending with #184.

### Production pre-flight findings — status

Tracked in issue #178. Evidence gathered programmatically so far
(read-only; production QBO and Stripe secrets are Vercel `sensitive`
env vars — unretrievable outside production compute, so the
integration/ledger questions below can only be answered by inspection
in the QBO and Stripe UIs):

| Finding | Status |
| --- | --- |
| Production connection live and healthy (`Deep Dive Brews, BV`, country CW) | ✅ verified (Firestore `qboConnections/production`, connection-check audit logs) |
| All six accounting mappings unset (`qboConfig/accountingMapping` absent) | ✅ verified |
| No sync records exist (`qboSyncRecords` empty) | ✅ verified |
| Real Stripe payments settle through the tool (`checkout.session.completed` → `paid` applied in prod) | ✅ verified (`stripeEvents`, runtime logs) |
| `Account` webhook notifications received for the production realm | ✅ verified (`qboWebhookReceipts`) |
| Account/Item/Customer/TaxCode discovery queries succeed (one page each; result counts not logged) | ✅ verified (`qbo.api.entities` logs) |
| Which integration/feed creates Stripe-related entries today | ✅ **resolved (#178)** — see "Two Stripe lanes" below |
| Whether a Stripe clearing/merchant-fee account exists and what it receives | ✅ resolved — the company has a dedicated `Stripe Balance` account, plus Undeposited Funds, a credit-card/merchant-fee expense account, and the Mercury bank account |
| Whether per-charge revenue records already exist in the books | ✅ resolved — **two lanes**: Ollie invoices book wholesale revenue/tax; DDB-admin payments book nothing (proven: a live settled $5.00 payment has no QBO record) |
| Payout gross/net/fee split and bank-feed matching behavior | ✅ partially — Stripe payouts arrive into QBO as transfers involving Undeposited Funds; payouts can be **mixed-source** (Ollie + DDB on the same Stripe account); fee bookkeeping is partly manual |
| CW tax configuration and required `GlobalTaxCalculation` value | ⏳ pending — QBO tax settings + accountant (#184); launch posture stays no-tax-posted |
| QBO home currency / multicurrency vs USD card sales | ⏳ pending — QBO company settings; flagged before enabling writes |

### Two Stripe lanes — the decisive finding (#178 resolved)

Manual inspection of the production books established that **the same
Stripe account serves multiple source systems**:

- **Lane A — Ollie / Spreedly wholesale.** Ollie creates QBO Invoices
  (revenue + tax already booked in QBO), then collects via Stripe.
  The Stripe charges carry Ollie metadata (e.g. an `order_id` matching
  the QBO invoice number and `connect_agent` identifying the external
  system). **DDB must never post revenue for these** — Ollie owns that
  lane end to end.
- **Lane B — DDB admin payments.** A live $5.00 payment created
  through `/admin/payments` (purpose `other`, internal payment id in
  Stripe metadata) settled with a real Charge (fee $0.45, net $4.55)
  and has **no QBO record at all**. The DDB integration must post this
  revenue leg itself.

Existing invoice payments in the books deposit to **Undeposited
Funds**, and Stripe payouts were observed arriving as transfers
involving Undeposited Funds — but the company also has a dedicated
**`Stripe Balance`** account intentionally used to model money
remaining inside Stripe (including a retained balance for
refunds/fees). DDB Sales Receipts deposit to the **configured Stripe
clearing/balance account**, not Undeposited Funds and never directly
to the bank. Because payouts mix Ollie and DDB charges, payout-level
reconciliation is a separate design problem (#181) — never per-payment
concern of this integration.

Classification rule: a payment qualifies for posting only through
**positive DDB identity** — it must be a canonical record in the app's
own `payments` collection (whose Stripe ids the tool itself issued and
verified), never inferred from amount/date matching, the absence of
`connect_agent`, or "not Ollie" heuristics.

## 3. Double-counting risks

| If the app posts… | …and the existing Stripe/bank path already posts… | Result |
| --- | --- | --- |
| Sales Receipts (gross revenue) | per-charge sales records of its own | **Duplicate revenue** |
| Deposits | bank-feed payout deposits | **Duplicate cash** |
| Fee expense lines | fee expense from the integration | **Duplicate expense** |
| Nothing | only deposits/fees, no revenue leg | Revenue unbooked (status quo) |

The one-sided risk is real in both directions: posting too much
double-counts; posting nothing leaves Stripe revenue out of the books.
The design must post exactly the **revenue leg** and nothing else —
*unless* inspection shows a revenue leg already exists.

## 4. Options considered

### Option A — Sales Receipt → Stripe clearing account

One QBO **Sales Receipt** per settled payment: line item by purpose at
the **gross** amount, `DepositToAccountRef` = Stripe clearing account.
Stripe payouts (net) and fees are supplied by the existing Stripe/bank
path; the clearing account absorbs the gross-vs-net difference.

- Correct revenue recognition per transaction, correct item-level
  income split (tours vs tastings).
- Clearing account is the standard Stripe pattern: gross in, net+fees
  out, residual = funds in transit.
- Risk: if the existing path also posts revenue → double-count (Section
  3). Gated on inspection.

### Option B — Invoice + Payment

Invoice then a Payment against it, landing in clearing/undeposited.

- Designed for receivables: a gap between billing and settlement.
- DDB payments settle **immediately** via Checkout — there is no AR
  window. Two extra entities per sale buys matching complexity and
  open-invoice noise with zero benefit. **Rejected.**

### Option C — Minimal accounting-event posting (revenue leg only)

Post only sales facts (gross Sales Receipts into clearing), never
deposits/fees/journals; rely on the existing path for all cash movement.

- This is Option A with the cash side explicitly delegated — it is the
  cleanest no-double-counting surface when the existing path already
  owns deposits/fees. **This is the recommendation (A/C hybrid).**

### Option D — Do not post

If the existing Stripe integration already creates sufficient
transaction-level revenue records, our posting is unnecessary and the
sync seam should instead power **reconciliation-only** reporting (match
each settled payment to an existing QBO record; flag unmatched).

- Correct answer *only if* inspection proves a revenue leg exists. Held
  in reserve.

## 5. Recommended model

**Per settled DDB-admin payment: one Sales Receipt, gross, into the
configured Stripe clearing/balance account. The app writes nothing else
— no deposits, no fee entries, no journals, and nothing at all for
Ollie or other non-DDB Stripe activity.** Only payments with positive
DDB identity (a canonical `payments` record the tool itself issued and
verified through Stripe) qualify — see the classification rule in §2.

| Element | Decision |
| --- | --- |
| QBO entity per payment | `SalesReceipt` |
| Amount | **Gross** in QBO decimal currency units — `amountMinor` is integer **cents**, so the boundary must convert (`amountMinor / 100`, e.g. `10000` → `100.0`). The same conversion applies to RefundReceipts |
| Transaction date | `TxnDate` = the payment's **`paidAt`** settlement date (refund's `refundedAt` for RefundReceipts) — never the worker's processing date, so delayed retries and backfills land in the correct accounting period |
| Cash target | `DepositToAccountRef` = mapped **Stripe clearing/balance account** (the company's `Stripe Balance` account is the expected choice) — *not* a bank account, *not* Undeposited Funds, and never hardcoded |
| Income split | Line `ItemRef` by `purpose` → mapped income item |
| Customer | One generic customer (mapped fallback) — see §6 |
| Payment method | Optional `PaymentMethodRef` ("Stripe") if a suitable method exists — nice-to-have, not required |
| Tax | **No tax posted** initially — see §10 |
| Deposits | **Never created** — cash movement belongs to the existing Stripe/bank path |
| Fees | **Never posted by the app** — see §9 |
| Currency | USD, as recorded. If QBO multicurrency/home currency is not USD, flag to accountant before enabling (amounts post as numbers; exchange treatment is a company-settings question) |

**Why this model:**

- Revenue is the only leg Stripe does not already represent in a way the
  app can rely on (and the only leg giving tour/tasting income detail).
- It composes with *any* cash-side path — bank feed, payout sync, or
  manual entry — because the clearing account is the seam.
- It is the smallest write surface that satisfies the goal; everything
  else is either redundant (B) or double-counting risk (deposits/fees).
- It degrades gracefully: if inspection shows an existing revenue leg,
  the same pipeline becomes Option D reconciliation with no re-architecture.

**What happens when mappings change later:** posted Sales Receipts keep
the entity ids they were written with; a mapping change affects only
future posts. Re-mapping is not a reason to edit history.

**What happens if QBO is unavailable when Stripe succeeds:** nothing
visible to the customer or staff. The sync record is already durable
(`pending`); a retry path posts it later. Stripe settlement is never
coupled to QBO availability — see §13.

## 6. QBO entities used

- **SalesReceipt** — created per payment (the only write).
- **Account** — one Stripe clearing account (existing or to be created
  manually in QBO; the app does not create accounts).
- **Item** — tour / tasting / other service items mapped to purposes.
- **Customer** — a single generic customer. Per-customer QBO records are
  deliberately avoided: counter sales gain no AR benefit, customer names
  vary in quality, and the receipt/email already lives in Stripe + the
  payment record. If a named customer is ever needed, it is a later
  decision, not a mapping.
- **RefundReceipt** — created per refund (see §8).
- **PaymentMethod (optional)** — display grouping only.

**Purposes → items (proposed; staff confirm at mapping time):**

| `purpose` | Item mapping |
| --- | --- |
| `brewery_tour` | tour income item |
| `additional_guests` | tour income item (it's tour volume) |
| `private_tour` | tour income item (or "other" if the accountant prefers) |
| `brewery_tour_tasting` | tasting income item |
| `other` | other income item |

## 7. Stripe event → QBO transaction mapping

| Payment-tool transition | Sync record | QBO write |
| --- | --- | --- |
| `paid` (via `checkout.session.completed`/async or manual refresh) | `stripe_payment` enqueue at the `paid` commit | `SalesReceipt` (gross → clearing) |
| `refunded` (via `commitRefund`) | `stripe_refund` enqueue at the `refunded` commit | `RefundReceipt` referencing the original receipt's lines |
| `processing`, `failed`, `expired`, `canceled`, `created`, `awaiting_payment` | none | none — no money moved |
| Dashboard refund (outside the app) | **gap** — see §8 | **gap** — see §8 |
| Stripe payout arrives | none | none — existing path owns cash |

The enqueue happens inside the same code path that commits the status
transition (`applyOutcome`/`commitRefund`), best-effort after the
Firestore commit so a QBO-side hiccup can never roll back a payment
transition.

## 8. Refund model

**`RefundReceipt`.** It is the Sales-Receipt-counterpart credit document:
it reverses the income lines and pays out of the same clearing account,
mirroring exactly how the sale was posted.

| Alternative | Why not |
| --- | --- |
| `CreditMemo` | AR-side credit against a *customer balance* — pairs with Invoice workflows, not immediate receipts. Wrong model for us. |
| Negative Sales Receipt | Not a supported QBO transaction shape. |
| Journal entry | Loses item/customer linkage; opaque to audit. |
| `Payment` reversal | No inverse operation; not how QBO models refunds. |

**Full refund:** RefundReceipt with the same line(s) and total as the
original Sales Receipt. **Partial refund** (not currently possible
in-app, but the model must not preclude it): same entity with the
reduced line amounts.

**Known gap — Stripe Dashboard refunds.** The app only learns about
refunds it initiated (1-hour window, full amount). A later or partial
Dashboard refund produces no `stripe_refund` sync record. Two
mitigations, to be scoped in the implementation issue:

- subscribe to `charge.refunded` (and/or `refund.created/updated`) on
  the Stripe webhook and synthesize sync candidates from canonical
  Stripe state — preferred; or
- accept manual QBO handling for out-of-band refunds (documented
  procedure; likely fine given rarity — but decide explicitly, don't
  discover it).

## 9. Clearing / reconciliation model

```
Stripe charge (gross)  ──SalesReceipt──►  Stripe clearing account
Stripe payout (net)    ──existing path──► Stripe clearing account
Stripe fees            ──existing path──► Fee expense account
                              residual ≈ payouts in transit
```

- The clearing account balance should trend to ~0 plus in-transit
  payouts. A growing balance means either missing cash-side records or
  duplicated gross receipts — an ops signal, not an app error.
- The app provides no reconciliation computation initially; the mapping
  UI's clearing-account choice is the only coupling. A future
  read-only "unmatched" report (synced records vs clearing activity) is
  a stretch item, not a launch requirement.
- **Fees:** the app never posts them. If inspection shows the existing
  path does not book fees either, the remediation is a periodic journal
  entry by the accountant (or a mapped `stripeFeeExpenseAccountId` +
  balance-transaction fee fetch — deferred until inspection proves the
  need; the app currently does not even read fee amounts).

## 10. Tax assumptions and limitations

- Company country is **CW (Curaçao)**. Do not assume US sales-tax
  semantics, TaxCode names, or inclusive/exclusive conventions.
- **Launch posture: no tax is posted.** Sales Receipts are created
  without a `TaxCodeRef` (QBO treats lines per company tax settings;
  for an untaxed service this is typically correct as "out of scope /
  non-taxable").
- **Non-US transactions must set `GlobalTaxCalculation` explicitly** —
  QBO requires the field on sales transactions for non-US companies.
  The intended value is `NotApplicable` (no tax regime applies to the
  line), but the exact accepted value depends on the company's tax
  configuration and must be confirmed in the pre-flight tax check
  (§2 item 6) — for a company with a configured tax regime the correct
  treatment may differ. This is a required payload field, not an
  optional nicety.
- `taxCodeId` stays **optional and unset** until the accountant confirms
  whether tour/tasting revenue carries Curaçao turnover tax (OB) and
  which TaxCode the company uses. The mapping field exists so that a
  confirmed answer needs no code change — only configuration.
- Risk acknowledged: if the company's tax settings *require* a code on
  sales lines, posting without one may need correction — the pre-flight
  checklist (§2 item 6) answers this before writes are enabled.

## 11. Mapping requirements

| Current field | Verdict | Rationale |
| --- | --- | --- |
| `stripeClearingAccountId` | **Required** — rename label to "Stripe clearing account" | The whole model hangs on it |
| `tourIncomeItemId` | **Required** | Covers tour + additional guests (+ private tour) |
| `tastingIncomeItemId` | **Required** | `brewery_tour_tasting` purpose exists |
| `otherIncomeItemId` | **Required** | `other` purpose needs a home |
| `fallbackCustomerId` | **Required** — rename to "Stripe sales customer" | Always used in this model (single generic customer), so "fallback" understates it |
| `taxCodeId` | **Optional — keep unset** | Until the CW tax answer is confirmed (§10) |

**Candidate new mappings — none required at launch:**

- `stripeFeeExpenseAccountId` — only if inspection shows nobody books
  fees AND the decision is to automate rather than periodic JE.
- `stripePayoutBankAccountId` — not needed; the app posts no deposits.
- `stripePaymentMethodId` — optional display nicety.
- Tax liability account — managed by QBO tax settings, not our posting.

## 12. Idempotency strategy

The existing seam is preserved exactly — durable record before write,
deterministic internal identity, QBO ids as correlation only.

| Source event | `sourceType` | `sourceId` | Notes |
| --- | --- | --- | --- |
| Settled payment | `stripe_payment` | internal `paymentId` (doc id / clientRequestId) | Stable from creation; `externalRefs` carry `sessionId`, `paymentIntentId`, `chargeId` |
| Refund | `stripe_refund` | `stripeRefundId` | One refund per payment today; canonical provider id |
| (Future) payout | `stripe_payout` | Stripe payout id | Only if payout work ever lands |

- A replayed `paid` transition, a redelivered Stripe webhook, or a
  retried worker run hits the existing `qboSyncRecords` document and
  returns `duplicate` — never a second Sales Receipt.
- Worker behavior on an existing record: `synced` → no-op; `syncing`
  (stale lease) → re-check whether a QBO write actually landed
  (query by a stored doc number/private note correlation) before
  writing again; `failed` → retry per §13.
- The QBO-side correlation written into the Sales Receipt (e.g.
  `PrivateNote`/`DocNumber` containing `paymentId` + `paymentIntentId`)
  gives a findable, human-auditable back-reference — belt to the
  Firestore-dedupe suspenders, not a replacement.

## 13. Failure / retry behavior

- **Enqueue is best-effort, post-commit**: if it throws, the payment is
  still `paid`; a sweeper finds payments with no sync record and enqueues
  them (reconciliation job or on-demand admin action).
- **Trigger mechanism (open design point):** no cron exists in this repo
  today (`vercel.json` has no `crons`). Options: (a) Vercel Cron hitting
  an authenticated sweep route — preferred, bounded, observable; (b)
  fire-and-forget processing inside the Stripe webhook request —
  simplest but dies with the request on hard failure; (c) enqueue-then-
  sweep hybrid: attempt inline, sweep hourly for stragglers. Decide in
  the implementation issue.
- **Attempts/backoff:** `attempts` counter + `lastAttemptAt` exist on
  the record; bounded retries on transient `QboError`s
  (`unavailable`/`rate-limited`), straight to `needs_attention` on
  `validation` (bad mapping, deleted entity) — human fixes config, then
  a retry action re-queues.
- **`invalid_grant` / reauthorization_required:** sync pauses cleanly;
  pending records accumulate safely until reconnect.
- **QBO write succeeded but response lost:** the worst case — a
  `syncing` record with no recorded `qboEntityId` must be reconciled by
  querying for the correlation reference (§12) before re-posting.

## 14. Rollout plan

1. **Pre-flight gate (blocking):** Chad completes §2 inspection; answers
   recorded in the implementation issue. If an existing revenue leg is
   found → pivot to Option D before any write work.
2. Create the **Stripe clearing account** in QBO (manual, accountant
   confirms type — typically Other Current Asset or Bank).
3. Configure mappings (clearing + 3 items + generic customer; tax code
   left unset).
4. Implement the sync worker behind the existing seam; **shadow mode
   first** (compute + log what would post, no writes) for a soak period.
5. Enable writes for **new** payments only; verify the first payout
   reconciliation with the accountant.
6. Optional: backfill prior settled payments via a bounded admin action.
7. Refund sync after refund coverage (incl. Dashboard-refund gap) is
   decided.
8. Only then consider: fee automation, recon reports, per-customer
   records — each a separate decision.

## 15. Manual verification checklist

Pre-flight (blocking — fill in before enabling writes):

- [ ] §2 items 1–6 answered and recorded (apps connected, clearing
      account presence, bank feed behavior, existing sales records, a
      real payout's categorization, tax settings).
- [ ] Stripe clearing account exists in the prod chart of accounts.
- [ ] Income items for tour / tasting / other exist and are active.
- [ ] Generic customer exists (e.g. "Stripe Checkout").
- [ ] CW tax treatment of tour/tasting sales confirmed with accountant.

Post-enable (first cycle):

- [ ] A real `paid` payment produces exactly one Sales Receipt (gross,
      correct item, clearing account, correct customer).
- [ ] Re-delivering the Stripe webhook / re-running the worker produces
      no second Sales Receipt (`duplicate` outcome).
- [ ] Next payout: clearing balance decreases by net+fees; residual =
      in-transit only.
- [ ] A refund produces exactly one RefundReceipt referencing the
      original sale's lines.
- [ ] QBO outage during a paid transition → payment unaffected; sync
      record retries to `synced` after recovery.
- [ ] `intuit_tid` correlation ids present in `qbo.*` logs for support.

## Open questions for Chad / accountant

1. What exactly creates Stripe-related entries in the books today
   (app, bank feed, manual)? — §2, **blocking**.
2. Is tour/tasting revenue subject to Curaçao turnover tax, and which
   TaxCode should carry it? — §10.
3. Is the QBO home currency USD? If ANG/other, how should USD card sales
   be represented? — §5.
4. Should `private_tour` map to the tour item or "other" income? — §6.
5. Who currently books Stripe fees, and at what cadence? — §9.
6. Are Dashboard (out-of-app) refunds frequent enough to require
   `charge.refunded` webhook coverage at launch, or is a manual
   procedure acceptable for v1? — §8.

## App-foundations extraction notes (for later)

- Clearing-account pattern: gross sales in, provider payouts+fees out,
  residual = in-transit; post exactly one leg.
- "Inspect before write" — discover the existing provider/integration
  behavior before choosing a posting model; secrets may make the books
  unreachable, so ship an explicit manual checklist as a gate.
- Deterministic internal source identity as the dedupe anchor; provider
  entity ids are correlation only; durable record before any write.
- Provider-correlation back-reference (`PrivateNote`/`DocNumber`) as
  findable audit trail.
- Tax portability: company country drives tax semantics; never infer
  jurisdiction rules; "no tax posted" is a valid conservative default.
- Out-of-band provider events (Dashboard refunds) are a real coverage
  gap — enumerate which events the app cannot see.
