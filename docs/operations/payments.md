# Payments operations

Operational reference for the admin payments feature (`/admin/payments`,
issue #155). Staff-facing usage lives in
[docs/admin/payments.md](../admin/payments.md); the implementation is
described in [docs/TECHNICAL.md](../TECHNICAL.md#admin-payments-adminpayments-issue-155)
§11. This page covers configuration and verification only — it is not app
code.

## Payment-method policy

Stripe Checkout is restricted to the card payment rail
(`payment_method_types: ["card"]` — see
[Admin payments](../TECHNICAL.md#admin-payments-adminpayments-issue-155)
in the technical reference for how the session is built). The policy:

- **Accepted:** immediate card-based methods Stripe presents through the
  card rail — normal card entry, plus eligible accelerated card methods
  such as Link, Apple Pay, and Google Pay, which appear depending on
  customer device/account eligibility. All of these settle immediately.
- **Not intentionally enabled:** delayed/asynchronous methods — ACH/bank
  debit, Klarna, Affirm, and similar BNPL or bank-payment methods. Counter
  charges must settle while the customer is present; a method that
  confirms days later would leave a charge looking unpaid.

Specifying `payment_method_types` explicitly overrides the Dashboard's
dynamic payment-method settings, so enabling e.g. Klarna in the Stripe
Dashboard does **not** surface it — only methods listed in code are
offered. Do not switch to Dashboard-managed (dynamic) payment methods
without re-deciding this policy, and do not try to suppress Link or
wallets that ride the card rail.

The `checkout.session.async_payment_succeeded` /
`checkout.session.async_payment_failed` webhook handlers stay wired as
defensive coverage: they cannot fire under the current card-only
configuration, but they keep the state machine correct if the account's
payment-method settings are ever broadened, and the canonical-session
decision treats them identically to other Checkout events either way.

## Receipts

- The app passes the customer's email to Stripe (`customer_email` +
  `payment_intent_data.receipt_email`) and stores Stripe's hosted
  `receipt_url` once the payment settles. Staff see a **View receipt**
  link on a paid payment's detail view — the fallback that works
  regardless of email settings. Enrichment is best-effort, so if a paid
  payment shows no receipt link, open the charge's hosted receipt from
  the Stripe Dashboard instead (and check for `payment.enrichment_failed`
  warnings — see [observability.md](./observability.md)).
- **Automatic receipt emails depend on the Stripe account's email
  settings**, not just the app. For customers to receive a receipt email
  in production, enable it in Stripe Dashboard → Settings → Emails →
  "Email customers about successful payments". `receipt_email` supplies
  the address; it does not force the account-level feature on.
- **Stripe test mode never sends email.** No receipt email arriving for a
  test payment is expected behavior, not a bug — use **View receipt** to
  verify.
- Stripe remains the receipt provider for Stripe payments. The app does
  not send its own receipts (no Resend receipt flow exists or is wanted).

## Webhook result semantics

`POST /api/webhooks/stripe` answers `{ ok: true, result: ... }` with one
of:

| Result | Meaning |
| --- | --- |
| `applied` | The event produced a recorded state transition (and any `paid` enrichment) atomically with its dedupe marker. |
| `ignored` | A valid delivery that needed no state transition — unhandled event type, no payment reference, or the record was already at/past the target state. **Valid outcome, not an error.** A common cause: a staff **Refresh status** settled the payment moments before the webhook arrived. |
| `duplicate` | This exact Stripe **event id** was already durably processed — a Stripe resend/retry. Exits before touching the payment. |
| `unknown_payment` | The event's `paymentId` has no record (foreign session or deleted record) — acked so Stripe stops retrying; logged as a warning. |
| `quarantined` | Canonical session contradicted the stored snapshot (session/amount/currency) — settlement refused, `reconciliation_mismatch` recorded, needs staff review. |
| `retry` (HTTP 500) | Canonical session state had not settled for the delivered event type — deliberately unanswered so Stripe redelivers. |

Resend model: the **first** delivery of an event id resolves to
`applied`/`ignored`/`unknown_payment`/`quarantined` depending on state;
every later delivery of the **same event id** resolves to `duplicate`.
Neither `ignored` nor `duplicate` writes payment updates or a second
`payment_succeeded` history entry — the dedupe marker and the state
machine together make double settlement impossible. Manual refresh and
the webhook share one planner, so whichever path reaches canonical Stripe
state first wins, and the loser safely no-ops; the history shows
"(manual refresh)" attribution when staff action settled the payment.

## Verifying webhook delivery end-to-end (manual)

The workspace polls Stripe while a payment detail view is open, so the
webhook path itself is proven only when nothing is polling. To confirm
webhook-driven settlement on a deployed environment:

1. Create a fresh payment in `/admin/payments` — note its id, then
   navigate away (do **not** keep its detail view open, or the view's own
   polling may reconcile first).
2. Complete the Stripe Checkout in a separate tab/device (test card in
   test mode).
3. Confirm the delivery in Stripe Dashboard → Developers → Webhooks → the
   endpoint → the event shows a 2xx response.
4. Open the payment detail afterward and confirm the status is **Paid**.
5. In the history, `Payment succeeded` appears **without** the
   "(manual refresh)" suffix — proof the webhook path applied it.
6. Optional: resend the same event from the Dashboard and confirm the
   response is `duplicate` with no second `payment_succeeded` entry.

If a manual refresh legitimately beats the webhook by a moment, the
webhook resolves `ignored` — see the semantics table above; that is
correct behavior, not a missed delivery.

## Refunds

The app supports **full refunds only**, in-app for **1 hour after `paidAt`**
and only for payments it settled. The window is strict — exactly 1 hour
elapsed means the window has passed — and is enforced server-side inside
the claim transaction; the UI only mirrors it. After the window, and for
partial refunds or anything unusual, the Stripe Dashboard is the tool.

Safety model (`refundAdminPayment` in `lib/payments-admin.ts`):

1. A Firestore transaction durably claims the refund — `refunding` status
   plus a `refund_requested` audit event. Two simultaneous requests cannot
   both claim; a retried request on a `refunding` record **resumes** rather
   than re-claiming, and a request on a `refunded` record is a safe no-op.
2. Provider calls stay outside transactions. Before mutating, the canonical
   PaymentIntent is re-fetched and verified against the stored record:
   same intent id, same internal `paymentId` metadata (when present), same
   amount, same currency, `status: "succeeded"`, and an existing charge
   that is not already refunded and carries no in-flight (`pending`/
   `requires_action`) refund. Any disagreement rejects with a safe code
   and releases the claim back to `paid` (`refund_failed` event).
3. `refunds.create` runs with the deterministic idempotency key
   `refund:<paymentId>:<attempt>` — `attempt` is a durable counter
   incremented by each claim, never by a resume. A Stripe-side replay of
   the same attempt returns the same refund object instead of minting a
   second one; a fresh claim after a released failure gets a fresh key so
   a saved provider error cannot doom retries. The durable claim is the
   primary guard; the Stripe key is the second layer.
4. Results commit inside a second transaction. If the provider call fails,
   canonical state is re-checked first: a charge Stripe already reports
   refunded (our own timed-out attempt, or a Dashboard refund) converges to
   `refunded`; only canonical proof that **no** refund exists releases the
   claim; an unreadable canonical state keeps `refunding` so the next
   request reconciles — never a blind second `refunds.create`.
5. Card refunds are asynchronous: a refund Stripe reports `pending` or
   `requires_action` is **not** committed — the record stays `refunding`
   with the Stripe refund id persisted, and the next request reconciles
   the canonical `Refund.status` (retrieve, not `amount_refunded`, which
   only reflects settled refunds): `succeeded` commits, `failed`/
   `canceled` releases the claim for a genuine retry, still-pending stays
   `refunding`. There is no polling loop — staff retries drive
   reconciliation, and a `refunding` record left stuck is reconciled by
   the next refund attempt or visible in the Stripe Dashboard.
6. `refunding` and `refunded` are Stripe-terminal: checkout webhooks and
   manual refresh can never regress them, and a refund racing a refresh is
   harmless because session-level events no longer apply.

Facts persisted per refund: `stripeRefundId`, `refundAmountMinor`,
`refundCurrency`, `refundReason`, `refundedByUid`/`refundedByName`,
`refundRequestedAt`, `refundedAt`, `stripeRefundStatus`, and a safe
`refundFailureMessage` code on failure — enough for a future accounting
sync (e.g. QuickBooks refund recognition) without ever storing raw Stripe
payloads. No refund webhook events are subscribed: the synchronous
`refunds.create` response plus canonical re-fetch covers this workflow —
card refunds can be asynchronous (`pending`), but reconciliation is driven
by the next staff refund request checking canonical `Refund.status`, so
a webhook subscription would add surface without changing the outcome.

## QuickBooks posting (settled payments)

Every canonical `paid` commit — webhook-applied or manual-refresh — also
hands the payment to the QuickBooks sync (`postPaidPaymentToQbo`,
`lib/qbo-sync.ts`): a durable `qboSyncRecords` entry keyed
`{environment}:stripe_payment:{paymentId}` and an inline attempt to post
one gross Sales Receipt to the mapped Stripe clearing account. The
export is strictly downstream: it is best-effort, idempotent, and can
never change the payment's status. Only payments originating in this
tool qualify — Ollie/Spreedly and other foreign Stripe activity have no
`payments/` record and never reach the seam. Model, mappings, failure
behavior, and the no-backfill rule are in
[quickbooks.md](./quickbooks.md#sales-receipt-sync-ddb-payments-only).

## Stripe API versions

Two API versions coexist deliberately — the webhook endpoint is pinned to
`2023-10-16` while the installed `stripe` SDK pins its own version for
outbound calls; the mechanism and current values are in
[Admin payments](../TECHNICAL.md#admin-payments-adminpayments-issue-155).
A Dashboard "Latest API version" banner — and request logs showing the
newer version — are expected, not a prompt to change anything. Do not
casually upgrade the webhook endpoint's API version; if it is ever
changed, verify the fields `readStripeEventRefs` reads still exist in the
new payload shape.

## Production activation checklist

One-time, manual steps to take the feature live. All of it is Stripe
Dashboard + Vercel configuration — no code change.

**Prerequisite:** the full flow — Checkout completion, webhook-driven
**Paid**, receipt link, manual refresh fallback, and webhook resend →
`duplicate` — must already be verified in **test mode** on a preview
deployment (see "Verifying webhook delivery end-to-end" above). Live keys
are the last step, not the way to prove the flow works.

### Vercel (Production scope)

- [ ] `STRIPE_SECRET_KEY` = the **live** key (`sk_live_*`) — test keys
      (`sk_test_*`) must not be present in Production, and live keys must
      not be present in Preview/Development (the server refuses them).
- [ ] `STRIPE_WEBHOOK_SECRET` = the signing secret (`whsec_*`) of the
      **production** webhook endpoint below — each endpoint has its own
      secret; do not reuse a test or `stripe listen` secret.
- [ ] No publishable-key env var is needed — Checkout is fully hosted, so
      card entry happens only on Stripe's page.

### Stripe Dashboard (live mode)

- [ ] Webhook endpoint registered: `https://deepdivebrewing.com/api/webhooks/stripe`,
      API version `2023-10-16`, subscribed to
      `checkout.session.completed`, `checkout.session.expired`,
      `checkout.session.async_payment_succeeded`,
      `checkout.session.async_payment_failed` (the async pair is
      defensive coverage — see Payment-method policy).
- [ ] Branding (Settings → Branding / Business settings):
  - [ ] DDB logo/mark and icon uploaded (see `THEME_AND_BRANDING.md` for
        the brand assets and approved usage).
  - [ ] Brand/accent color set to the DDB palette.
  - [ ] Business name, statement descriptor, and support details
        (email/phone/address) are current — these appear on receipts and
        card statements.
- [ ] Checkout/Customer Portal branding reviewed (Settings → Checkout and
      Payment Links) so the hosted page shows the DDB brand.
- [ ] Receipts: "Email customers about successful payments" enabled
      (Settings → Emails) if automatic customer receipts are wanted, and
      the receipt email branding reviewed.

### Post-deploy live verification (intentionally manual)

Real-money check after merge/deploy — perform once, with a small amount:

1. Create a small real payment in `/admin/payments` (e.g. $1–2; refund it
   afterward — in-app within 1 hour, otherwise in the Stripe Dashboard).
2. Complete Checkout with a real card.
3. Confirm the browser returns to `/pay/complete`.
4. Confirm the live webhook delivery returns 2xx in the Stripe Dashboard.
5. Confirm the payment shows **Paid** (with no "(manual refresh)" tag if
   you followed the webhook-verification procedure above).
6. Confirm **View receipt** opens Stripe's hosted receipt.
7. Confirm the customer receipt email arrives if enabled above.
8. Confirm card brand/last4 appear on the payment detail.
9. Resend the webhook event from the Dashboard and confirm `duplicate`
   with no second `payment_succeeded` history entry.

## Related documents

- [docs/admin/payments.md](../admin/payments.md) — staff guide.
- [docs/TECHNICAL.md](../TECHNICAL.md) §11 — implementation.
- [credential-rotation.md](./credential-rotation.md) §H — Stripe key and
  webhook-secret rotation, preview webhook testing.
- [deployment.md](./deployment.md) — env-var scopes.
