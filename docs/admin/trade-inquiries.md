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
| **Island** | No | One of: Saba, Sint Maarten, Statia, St. Kitts, Nevis, Anguilla, Other. |
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
6. The server sends a notification email through **Resend** to the address configured in `TRADE_NOTIFICATION_EMAIL` (falling back to the legacy `TRADE_INQUIRY_TO_EMAIL` when unset). The email's reply-to address is set to the submitter's email, and the body links directly to the lead in the pipeline.
7. If the email fails after the inquiry was saved, the submission still counts as received — the inquiry is safely stored and the failure is logged for operators.

The email subject is:

```
New Trade Inquiry: <Business Name>
```

The email body contains all submitted fields (including island when supplied) in a simple HTML table, plus a link that opens the lead in `/admin/trade`.

## The trade pipeline (`/admin/trade`)

The normal operational workflow is the **Trade leads** page inside the admin app: sign in at https://deepdivebrewing.com/admin, then open the pipeline via the **Trade leads** summary (or go directly to `/admin/trade`). The Firebase console remains available for inspection and debugging, but it is no longer the day-to-day workflow.

### The list view

The left column lists every lead, newest first by default. Each row shows the business name, contact, business type, status, owner, island, follow-up state, and created/last-activity dates. Filters cover status, owner, business type, island (including "not set" for older leads), and follow-up state (overdue / due today / upcoming / none), plus a text search and newest/oldest/follow-up-first sorting.

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

Staff add notes with the **Add a note** box on the lead workspace — a note is the fastest way to log a conversation. The pipeline automatically records: lead created (with source), status changed (from → to), owner changed, island changed, follow-up set/moved/cleared, outcome recorded or cleared on terminal leads, and every sent or received email (see "Email on a lead" below).

### Follow-ups

Each open lead can carry a `nextFollowUpAt` date (optional). The UI highlights **Overdue** and **Due today** states in both the list and the lead workspace; classification is by calendar day in the viewer's timezone. Set, change, or clear the date from the lead workspace. Customer and closed leads cannot hold a follow-up — entering a terminal status clears it so they never show a misleading overdue badge.

### Island

Each lead can carry a single **island** value (Saba, Sint Maarten, Statia, St. Kitts, Nevis, Anguilla, Other) — shown as a badge on the list and the lead header, selectable in manual lead creation and the lead workspace, and filterable in the list. Leads created before this field existed show **No island** rather than being silently assigned one; set it from the lead workspace when known.

### Phone and WhatsApp

Phone/WhatsApp values are normalized on save (and on read for older records): readable input like `+599 416 3544`, `(721) 555-1234`, or a bare 7-digit Saba number becomes a canonical `+…` international number when it can be confidently interpreted. The workspace shows the formatted number with a `tel:` link, and a **WhatsApp** (`wa.me`) link appears only when the number normalized cleanly — a guessed WhatsApp link would reach the wrong account. Numbers that cannot be interpreted display as submitted, with no WhatsApp link.

### Email on a lead

The **Email** section in the lead workspace sends email directly from the app — no need to open your own mail client:

1. Click **Email this lead**, write a subject and message, and send. The message goes to the lead's contact address from the configured sender — `TRADE_FROM_EMAIL`, else `RESEND_FROM_EMAIL`, else `trade@mail.deepdivebrewing.com`.
2. The sent email appears in the lead's **History** with a delivery badge (Sent → Delivered, or Delayed/Bounced/Failed if the provider reports a problem).
3. When the customer replies, the reply lands back in the same history automatically — app-sent email sets its `Reply-To` to the lead's unique inbound address, and inbound webhooks attach the reply to the lead.
4. On an inbound email in the history, **Reply** opens the composer with the subject and threading headers prefilled so the conversation stays in one thread.

**Attach email to this lead**: every lead has a unique address (shown in the Email section, e.g. `7K4M2QX9@reply.deepdivebrewing.com`). When a customer emails a staff member directly, forward that email to the lead's address — the forwarded message attaches to this lead's history, no note-copying needed. Use the **Copy** button to grab the address.

### Staff notifications

System notifications are separate from the customer-facing conversation:

- **New inquiry**: a blanket notification goes to `TRADE_NOTIFICATION_EMAIL` (the shared trade mailbox — see Environment setup).
- **Customer reply**: the lead's **assigned owner** is notified at their admin account email. Unassigned leads fall back to `TRADE_NOTIFICATION_EMAIL`.
- Notifications link directly to the lead (`/admin/trade?lead=<id>`) and are never recorded in the customer-facing history.

### Manual lead creation

**New lead** opens a form recording business name, contact name, email and/or phone/WhatsApp, business type, island, a source (WhatsApp, Phone call, In person, Referral, Event / trade show, Email, Other), and initial notes. Manual leads start as **New** and flow through the same pipeline.

## Where inquiries are stored

**Firestore is the system of record.** Each inquiry is saved to the `tradeLeads` collection with:

- the submitted fields (business name, contact name, email, phone/WhatsApp, venue type, island, message), plus derived fields (`phoneNormalized` when the number parsed to E.164, and a random `replyToken` for inbound routing),
- `status`, `source`, pipeline fields (`assignedToUid`/`assignedToName`, `nextFollowUpAt`, `closedAt`, `outcome`), and `createdAt`/`updatedAt`/`lastActivityAt` timestamps,
- an `activities` subcollection holding the append-only history,
- a `communications` subcollection holding the full email records (bodies, threading headers, provider IDs, delivery state) that `communication` history entries reference.

The collection is **not readable by the website or admin dashboard client code** — Firestore rules deny all client access to `tradeLeads` and its `activities`/`communications` subcollections. Admin reads and writes flow through authenticated `/api/admin/*` routes that verify the Firebase ID token, the admin custom claims, **and** an active `adminUsers` record (`requireAdminActor`). Resend webhook events use the separate, signature-verified `/api/webhooks/resend` write path. Server-side code (Admin SDK) is the only data path.

The email to `TRADE_NOTIFICATION_EMAIL` is a **notification**, not the only copy — if the email fails, the inquiry is still stored.

> **Data handling:** stored leads contain business contact details (PII). Retention is governed by the policy below.

## Retention policy

Trade inquiries are retained for **up to 24 months after the last meaningful activity** on the record (`updatedAt`), unless there is a legitimate business, legal, accounting, dispute, or security reason to keep them longer. They may be deleted earlier when no longer needed.

**Meaningful activity** is a real lead mutation: adding a note, changing status, assigning an owner, changing the island, setting/changing a follow-up, and sending or receiving email. These advance `updatedAt` and `lastActivityAt`. Merely **viewing** a lead in the pipeline writes nothing meaningful and does not extend its retention (first view of an older lead may provision its inbound routing token, which deliberately leaves the retention anchors untouched).

### Pruning expired leads

There is no automated deletion — pruning is a periodic manual maintenance task:

```bash
npm run prune:trade-leads              # dry run: prints cutoff, counts, document IDs
npm run prune:trade-leads -- --delete  # permanently deletes the expired documents
```

The script uses the same `FIREBASE_ADMIN_*` credentials as `bootstrap-superadmin` (loaded from `.env.local`). It prints only document IDs and aggregate counts — never inquiry contents — and leads whose timestamps cannot be read are reported and kept, never deleted. Deleting a lead also deletes its `activities` and `communications` subcollections in bounded batches (Firestore document deletes do not cascade). Before deleting, an operator may review a lead in the pipeline or the Firebase console to confirm no retention exception applies.

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

1. Watch the **Trade leads** summary on the admin dashboard (or the `TRADE_NOTIFICATION_EMAIL` inbox) for new inquiries.
2. Open the lead in `/admin/trade` and reply with the built-in **Email** composer — replies come back into the same lead automatically. **Call** (`tel:`) and **WhatsApp** (`wa.me`) links remain available for non-email contact. If a send fails (the timeline entry shows *Failed* or stays *Queued*), the **Resend** button on the entry replays the exact same message — it is idempotent, so a retry can never send the customer a duplicate.
3. If the customer emailed you directly, forward that email to the lead's **Attach email** address instead of copying it into a note.
4. Log anything else with **Add a note**, set a **next follow-up** date when a next step is needed, and move the status forward.
5. Keep business and contact details confidential; do not forward inquiry details to unauthorized recipients.

## Email routing and webhooks (setup)

Email is powered by Resend with three pieces of configuration:

| Variable | Purpose |
|---|---|
| `TRADE_FROM_EMAIL` | Sender for customer-facing lead email. Optional — falls back to `RESEND_FROM_EMAIL`, then `trade@mail.deepdivebrewing.com` on the verified sending domain. |
| `TRADE_REPLY_DOMAIN` | Domain for per-lead inbound addresses (`<token>@<domain>`). Defaults to `reply.deepdivebrewing.com`. |
| `RESEND_WEBHOOK_SECRET` | Signing secret (`whsec_…`) for `POST /api/webhooks/resend`. Required for inbound replies and delivery callbacks; the endpoint refuses all events without it. |
| `TRADE_NOTIFICATION_EMAIL` | Staff mailbox for new-inquiry alerts and replies on unassigned leads. Falls back to legacy `TRADE_INQUIRY_TO_EMAIL`. |

Setup steps:

1. **Inbound domain** — configure the reply domain (`TRADE_REPLY_DOMAIN`) for inbound email in Resend (MX records per the Resend inbound docs). Every lead's address is `<random 8-char token>@<domain>`; the token is generated per lead and never exposes the Firestore ID.
2. **Webhook** — in the Resend console, add a webhook pointing at `https://deepdivebrewing.com/api/webhooks/resend` subscribed to `email.received` and the delivery events (`email.delivered`, `email.bounced`, `email.delivery_delayed`, `email.complained`, `email.failed`, `email.sent`). Copy the signing secret into `RESEND_WEBHOOK_SECRET`. Requests are verified against the signature before any payload is processed; invalid signatures are rejected, repeats are deduplicated, and unknown routing tokens are ignored safely.
3. **Delivery state** — delivery callbacks update the communication's `deliveryState` (shown as a badge on outbound email). Events can arrive out of order or repeat; only forward-moving states are applied.

Attachments on inbound email are **metadata-only** for now — the timeline shows the attachment name/size but content is not downloaded or stored.

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
