# Trade Inquiries

This guide explains how wholesale and trade inquiries reach the team, what information is collected, how to work the lead pipeline in the admin app, and how to handle submissions safely.

## Where trade inquiries originate

Visitors submit trade inquiries through the form on the public page:

https://deepdivebrewing.com/trade

The form is also linked from the beer listing and individual beer pages.

Administrators can also record leads by hand — a phone call, a WhatsApp message, an in-person conversation, a referral, or a trade-show contact — from the trade pipeline (see below). Manual leads carry their own `source` value; `trade_form` is reserved for the public form.

## Fields collected

The form asks for the following information:

| Field | Required | Notes |
|---|---|---|
| **Business name** | Yes | The bar, restaurant, hotel, retail store, or distributor. |
| **Your name** | Yes | The person requesting the trade partnership. |
| **Email** | Yes | Used as the reply-to address. |
| **Phone / WhatsApp** | No | Optional contact number. |
| **Business type** | Yes | One of: Bar, Restaurant, Hotel, Retail, Distributor, Other. |
| **Message** | No | Any extra details the submitter wants to share. |

There is also a hidden honeypot field named `website`. Humans never see it. If it is filled, the submission is treated as spam and silently discarded.

For manual leads the requirements are looser: business name is required, plus at least one contact channel (email **or** phone/WhatsApp), since some real-world contacts arrive without an email address.

## Backend handling

When a visitor submits the form:

1. The browser sends a `POST` request to `/api/trade-inquiry`.
2. The server validates that the required fields are present.
3. If the honeypot field is filled, the request is ignored but responds with success so bots do not know they were blocked.
4. The server checks a per-IP rate limit (5 submissions per 10 minutes).
5. The server **persists the inquiry to the `tradeLeads` Firestore collection** — this is the durable record — and writes a `lead_created` entry to the lead's `activities` history.
6. The server sends a notification email through **Resend** to the address configured in `TRADE_INQUIRY_TO_EMAIL`. The email's reply-to address is set to the submitter's email, and the body includes the Firestore lead ID as a reference.
7. If the email fails after the inquiry was saved, the submission still counts as received — the inquiry is safely stored and the failure is logged for operators.

The email subject is:

```
Trade Inquiry — <Business Name> (<Contact Name>)
```

The email body contains all submitted fields in a simple HTML table, plus a `Reference` row with the lead ID.

## The trade pipeline (`/admin/trade`)

The normal operational workflow is the **Trade leads** page inside the admin app: sign in at https://deepdivebrewing.com/admin, then open the pipeline via the **Trade leads** summary (or go directly to `/admin/trade`). The Firebase console remains available for inspection and debugging, but it is no longer the day-to-day workflow.

### The list view

The left column lists every lead, newest first by default. Each row shows the business name, contact, business type, status, owner, follow-up state, and created/last-activity dates. Filters cover status, owner, business type, and follow-up state (overdue / due today / upcoming / none), plus a text search and newest/oldest/follow-up-first sorting.

### Lifecycle statuses

| Status | Meaning |
|---|---|
| **New** | Freshly received, not yet contacted. |
| **Contacted** | First reply or conversation happened. |
| **Follow-up** | Waiting on a next step — a call-back, samples, pricing. |
| **Customer** | They buy beer. Terminal; the record is kept. |
| **Closed** | Not proceeding. Terminal; the record is kept. |

A lead is never deleted when it becomes a customer or is closed — the full history stays. Closing a lead records `closedAt` and an optional free-text **outcome** (e.g. "First order placed", "Not a fit"). Reopening a lead (moving it back to an active status) clears `closedAt` and the outcome.

### Ownership

A lead can be assigned to any **active administrator** — the same `adminUsers` accounts as the rest of the admin app; there is no separate sales-user table. The owner name is snapshotted onto the lead (`assignedToUid` + `assignedToName`) so history stays readable. Assign or unassign from the Owner select in the lead workspace.

### Notes and history

History is **append-only**: each lead has an `activities` subcollection, and entries are never edited or overwritten. A timeline reads like a log:

- Oct 2, Chad: Spoke on WhatsApp. Interested in Saison.
- Oct 4, Malachy: Dropped off samples.
- Status changed from Contacted to Follow-up.
- Follow-up moved to Oct 18.

Staff add notes with the **Add a note** box on the lead workspace — a note is the fastest way to log a conversation. The pipeline automatically records: lead created (with source), status changed (from → to), owner changed, and follow-up set/moved/cleared.

### Follow-ups

Each open lead can carry a `nextFollowUpAt` date (optional). The UI highlights **Overdue** and **Due today** states in both the list and the lead workspace; classification is by calendar day in the viewer's timezone. Set, change, or clear the date from the lead workspace. Customer and closed leads cannot hold a follow-up — entering a terminal status clears it so they never show a misleading overdue badge.

### Manual lead creation

**New lead** opens a form recording business name, contact name, email and/or phone/WhatsApp, business type, a source (WhatsApp, Phone call, In person, Referral, Event / trade show, Email, Other), and initial notes. Manual leads start as **New** and flow through the same pipeline.

## Where inquiries are stored

**Firestore is the system of record.** Each inquiry is saved to the `tradeLeads` collection with:

- the submitted fields (business name, contact name, email, phone/WhatsApp, venue type, message),
- `status`, `source`, pipeline fields (`assignedToUid`/`assignedToName`, `nextFollowUpAt`, `closedAt`, `outcome`), and `createdAt`/`updatedAt`/`lastActivityAt` timestamps,
- an `activities` subcollection holding the append-only history.

The collection is **not readable by the website or admin dashboard client code** — Firestore rules deny all client access to `tradeLeads` and its `activities` subcollection. Every read and write flows through authenticated `/api/admin/*` routes that verify the Firebase ID token, the admin custom claims, **and** an active `adminUsers` record (`requireAdminActor`). Server-side code (Admin SDK) is the only data path.

The email to `TRADE_INQUIRY_TO_EMAIL` is a **notification**, not the only copy — if the email fails, the inquiry is still stored.

> **Data handling:** stored leads contain business contact details (PII). Retention is governed by the policy below.

## Retention policy

Trade inquiries are retained for **up to 24 months after the last meaningful activity** on the record (`updatedAt`), unless there is a legitimate business, legal, accounting, dispute, or security reason to keep them longer. They may be deleted earlier when no longer needed.

**Meaningful activity** is a real lead mutation: adding a note, changing status, assigning an owner, or setting/changing a follow-up. These advance `updatedAt` and `lastActivityAt`. Merely **viewing** a lead in the pipeline writes nothing and does not extend its retention.

### Pruning expired leads

There is no automated deletion — pruning is a periodic manual maintenance task:

```bash
npm run prune:trade-leads              # dry run: prints cutoff, counts, document IDs
npm run prune:trade-leads -- --delete  # permanently deletes the expired documents
```

The script uses the same `FIREBASE_ADMIN_*` credentials as `bootstrap-superadmin` (loaded from `.env.local`). It prints only document IDs and aggregate counts — never inquiry contents — and leads whose timestamps cannot be read are reported and kept, never deleted. Deleting a lead also deletes its `activities` subcollection (Firestore document deletes do not cascade). Before deleting, an operator may review a lead in the pipeline or the Firebase console to confirm no retention exception applies.

## Expected success behavior

After a successful submission:

- The form is replaced with a thank-you message.
- A `trade_form_success` analytics event is recorded (no personal information is included).

## Expected failure behavior

If submission fails:

- The form shows an error message describing the problem.
- A `trade_form_error` analytics event is recorded.
- Common failure reasons include missing or oversized fields, rate limiting, or a problem saving the inquiry. An email-delivery problem alone does **not** fail the submission — the inquiry is already stored.

## How administrators should respond

1. Watch the **Trade leads** summary on the admin dashboard (or the `TRADE_INQUIRY_TO_EMAIL` inbox) for new inquiries.
2. Open the lead in `/admin/trade`, then reply using the contact links — **email** (`mailto:`), **call** (`tel:`), or **WhatsApp** (`wa.me`). Messages are sent from your own mail client/phone, never by the app.
3. Log what happened with **Add a note**, set a **next follow-up** date when a next step is needed, and move the status forward.
4. Keep business and contact details confidential; do not forward inquiry details to unauthorized recipients.

## Communications scaffolding (future work)

Replying to leads directly from the app is intentionally **not implemented** yet. The data model is already channel-agnostic so it can be added later without redesigning: a sent or received message is an `activities` entry with `type: "communication"` plus a payload covering channel, direction, recipient/sender, subject/body, timestamps, provider, provider message ID, delivery state, and thread ID — so future email (Resend) or WhatsApp sends will appear in the same timeline as notes.

## Privacy considerations

- The form collects business contact information. Treat it as personal/business data.
- Submitted inquiries are stored in the `tradeLeads` Firestore collection (purpose: responding to trade/wholesale inquiries) **and** delivered by notification email.
- Retention: up to 24 months after last meaningful activity — see the retention policy above.
- Do not add submitted emails to marketing lists without consent.
- Do not copy inquiry details into insecure locations.
- Only authorized staff — administrators with an active `adminUsers` record — can see the pipeline. Lead PII is never sent to analytics; server logs use lead IDs and action names only.

## What information must never be sent to analytics

Analytics events are configured to avoid personally identifiable information (PII). The following must **never** be sent to analytics:

- Email addresses.
- Phone numbers.
- Business names tied to an individual.
- Any message text from the form or note text from the pipeline.

The current analytics events (`trade_form_start`, `trade_form_success`, `trade_form_error`) only record the event category, CTA location, and venue type. The admin pipeline emits no analytics events.

## Safe testing procedures

> **Warning:** Submitting the live form on https://deepdivebrewing.com/trade stores a real inquiry in Firestore (and sends a real email). Do not use production to run tests; delete test leads afterward.

To test safely:

1. Use a local development environment (`npm run dev`) with a test email address configured in `TRADE_INQUIRY_TO_EMAIL`.
2. Use the Resend test domain or a controlled inbox.
3. Do not enter real customer data during testing.
4. Delete test leads after verification (Firebase console, or let the prune script catch them once expired).

If you must test on production, coordinate with the email recipient so the test submission is expected and can be deleted.
