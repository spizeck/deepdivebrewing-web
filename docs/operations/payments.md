# Payments operations

Operational reference for the admin payments feature (`/admin/payments`,
issue #155). Staff-facing usage lives in
[docs/admin/payments.md](../admin/payments.md); the implementation is
described in [docs/TECHNICAL.md](../TECHNICAL.md#admin-payments-adminpayments-issue-155)
§11. This page covers configuration and verification only — it is not app
code.

## Payment-method policy

Stripe Checkout is restricted to the card payment rail
(`payment_method_types: ["card"]` in `buildCheckoutSessionSpec`). The policy:

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
  link on a paid payment's detail view — this is the reliable fallback
  and works regardless of email settings.
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

## Stripe API versions

Two versions coexist deliberately — do not read a dashboard "Latest API
version" banner as a prompt to change either:

- **Webhook endpoint** (Stripe Dashboard → Developers → Webhooks): pinned
  to `2023-10-16`. Event payloads arrive serialized under that version.
- **SDK calls** (`getStripeClient()`): pinned by the installed `stripe`
  package (`2026-08-26.dahlia` at stripe v22) — this is why most
  Dashboard request logs show the newer version.

This is safe by design: the webhook reads only the event id/type and the
Checkout Session id from the payload — fields stable across versions —
then **re-fetches the canonical session** through the SDK, so every
financial fact is read under the SDK's own version. Do not casually
upgrade the webhook endpoint's API version; if it is ever changed, verify
`readStripeEventRefs` fields still exist in the new payload shape.

## Production activation checklist

One-time, manual steps to take the feature live. All of it is Stripe
Dashboard + Vercel configuration — no code change.

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
   afterward in the Stripe Dashboard — refunds are not in the app).
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
