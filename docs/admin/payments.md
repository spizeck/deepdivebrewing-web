# Payments

This guide explains how staff take card payments for brewery tours and other one-off charges from the admin app — and what happens behind the scenes so the record stays trustworthy.

## Where it lives

Sign in at https://deepdivebrewing.com/admin, then open **Payments** from the dashboard summary — or go directly to `/admin/payments`.

The workspace has two halves:

- **Take payment** — create a new charge.
- **Recent payments** — the latest payments with their status. Select a row for the full detail and history.

## Taking a payment

1. Choose a **Purpose** — Brewery Tour, Brewery Tour + Tasting, Additional guest(s), Private tour, or Other. The tour purposes carry the published per-person prices, so entering an **Attendees** count suggests the amount automatically. You can always edit the amount — staff judgment wins for private tours, partial payments, and custom arrangements.
2. Fill in the **Description** (prefilled from the purpose), **Amount (USD)**, and **Customer name**. Receipt email, tour date, attendee count, and an internal note are all optional.
3. Click **Review payment** — the app shows the exact charge on a confirmation panel. Check the amount carefully.
4. Click **Create payment**. This creates the payment record and a secure Stripe payment link.

> The customer **never types their card into this app**. Card entry happens only on Stripe's hosted page — the app never sees, stores, or logs card numbers.

## Getting the customer to pay

Once created, the payment shows a live **payment link** with three ways to reach it:

- **Show QR** — best at the counter: the customer scans with their phone and pays on their own device.
- **Copy link** — paste it into WhatsApp, SMS, or email for a customer who isn't present.
- **Open payment page** — opens Stripe's hosted page in a new tab, useful on a shared tablet.

The status updates automatically while the customer pays (the app checks Stripe for a few minutes). **Refresh status** reconciles on demand — Stripe is the source of truth, so a slow notification never leaves a paid payment looking unpaid.

## Payment states

| Status | Meaning |
|---|---|
| **Setting up** | The record exists but the payment link is still being created — usually only for a second. |
| **Awaiting payment** | The link is live; the customer has not finished paying. |
| **Processing** | Stripe accepted the payment but the bank has not confirmed yet (rare for cards). |
| **Paid** | Money captured. Final — the Stripe webhook confirmed it. |
| **Failed** | The customer's attempt failed (e.g. a declined card). |
| **Expired** | The payment link timed out (~24 hours) unpaid. |
| **Canceled** | Staff canceled the payment before the customer paid. |

A payment is never marked paid because a browser landed on a success page — Stripe tells the server directly, and only then does the record become **Paid**.

## Canceling a payment

While a payment is **Awaiting payment** (or still setting up), use **Cancel payment** — it kills the payment link so it can no longer be used, and records the cancellation in the history. Paid, failed, and expired payments cannot be canceled from here. Refunds are not part of this tool yet — see an owner if a paid charge needs to be refunded (they are done in the Stripe Dashboard for now).

## Receipts

The **Receipt email** field pre-fills the customer's email on the Stripe Checkout page and associates it with the payment. Stripe emails a receipt automatically when the payment succeeds **if** automatic receipts for successful payments are enabled in the Stripe Dashboard (Dashboard → Settings → Emails → "Email customers about successful payments"). After a payment is **Paid**, the detail view also shows a **View receipt** link to Stripe's hosted receipt page — usable regardless of email settings — plus the card brand and last four digits, the only card details ever stored, and only as display metadata.

## Payment detail

Selecting a payment shows everything the app recorded: amount, purpose, description, customer, receipt email, tour date, attendees, who created it and when, the Stripe identifiers, receipt link, and an append-only **History** (created, link issued, succeeded/failed/expired, canceled, flagged-for-review).

## Test mode

When the app runs with Stripe **test** credentials, a **Test mode** badge appears on created payments. Test payments use Stripe's test cards and never move real money. If you see the badge in normal use, tell an owner — it means the deployment is configured with test keys.

## Troubleshooting

- **Payment stays "Awaiting payment" after the customer says they paid** — click **Refresh status**; the app asks Stripe directly.
- **The link doesn't work** — links expire after about 24 hours or when canceled. Create a fresh payment.
- **A payment shows "Needs attention"** — Stripe's report contradicted what was created (for example a different amount or currency), so the app refused to mark it paid. Check the session in the Stripe Dashboard and tell an owner.
- **A charge happened twice** — it shouldn't: retries reuse the same payment record and Stripe session. Report it to an owner with the payment's Stripe session id from the detail view.
