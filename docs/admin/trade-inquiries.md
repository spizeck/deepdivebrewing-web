# Trade Inquiries

This guide explains how wholesale and trade inquiries reach the team, what information is collected, and how to handle submissions safely.

## Where trade inquiries originate

Visitors submit trade inquiries through the form on the public page:

https://deepdivebrewing.com/trade

The form is also linked from the beer listing and individual beer pages.

## Fields collected

The form asks for the following information:

| Field | Required | Notes |
|---|---|---|
| **Business Name** | Yes | The bar, restaurant, hotel, retail store, or distributor. |
| **Contact Name** | Yes | The person requesting the trade partnership. |
| **Email** | Yes | Used as the reply-to address. |
| **Phone / WhatsApp** | No | Optional contact number. |
| **Venue Type** | Yes | One of: Bar, Restaurant, Hotel, Retail, Distributor, Other. |
| **Message** | No | Any extra details the submitter wants to share. |

There is also a hidden honeypot field named `website`. Humans never see it. If it is filled, the submission is treated as spam and silently discarded.

## Backend handling

When a visitor submits the form:

1. The browser sends a `POST` request to `/api/trade-inquiry`.
2. The server validates that the required fields are present.
3. If the honeypot field is filled, the request is ignored but responds with success so bots do not know they were blocked.
4. The server checks a per-IP rate limit (5 submissions per 10 minutes).
5. The server **persists the inquiry to the `tradeLeads` Firestore collection** — this is the durable record.
6. The server sends a notification email through **Resend** to the address configured in `TRADE_INQUIRY_TO_EMAIL`. The email's reply-to address is set to the submitter's email, and the body includes the Firestore lead ID as a reference.
7. If the email fails after the inquiry was saved, the submission still counts as received — the inquiry is safely stored and the failure is logged for operators.

The email subject is:

```
Trade Inquiry — <Business Name> (<Contact Name>)
```

The email body contains all submitted fields in a simple HTML table, plus a `Reference` row with the lead ID.

## Where inquiries are stored

**Firestore is the system of record.** Each inquiry is saved to the `tradeLeads` collection with:

- the submitted fields (business name, contact name, email, phone/WhatsApp, venue type, message),
- `status: "new"`, `source: "trade_form"`, and server-generated `createdAt`/`updatedAt` timestamps.

The collection is **not readable by the website or admin dashboard** — Firestore rules deny all client access, and only server-side code (the inquiry API route) writes to it. Administrators can view leads in the **Firebase console** (Firestore → `tradeLeads`); an admin UI may be added later if needed.

The email to `TRADE_INQUIRY_TO_EMAIL` is a **notification**, not the only copy — if the email fails, the inquiry is still stored.

> **Data handling:** stored leads contain business contact details (PII). There is currently no defined retention or deletion policy (tracked in issue #59) — see the privacy considerations below.

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

1. Monitor the inbox configured in `TRADE_INQUIRY_TO_EMAIL`.
2. Reply directly to the submitter using the reply-to address.
3. Keep business and contact details confidential; do not forward inquiry emails to unauthorized recipients.
4. Track follow-up status in your preferred CRM or email workflow. The website does not currently provide a lead-management interface.

## Privacy considerations

- The form collects business contact information. Treat it as personal/business data.
- Submitted inquiries are stored in the `tradeLeads` Firestore collection (purpose: responding to trade/wholesale inquiries) **and** delivered by notification email.
- No retention or deletion policy has been defined yet — old leads remain in Firestore until one is decided.
- Do not add submitted emails to marketing lists without consent.
- Do not copy inquiry details into insecure locations.
- Only authorized staff — those with access to the `TRADE_INQUIRY_TO_EMAIL` inbox or the Firebase project — should handle inquiries.

## What information must never be sent to analytics

Analytics events are configured to avoid personally identifiable information (PII). The following must **never** be sent to analytics:

- Email addresses.
- Phone numbers.
- Business names tied to an individual.
- Any message text from the form.

The current analytics events (`trade_form_start`, `trade_form_success`, `trade_form_error`) only record the event category, CTA location, and venue type.

## Safe testing procedures

> **Warning:** Submitting the live form on https://deepdivebrewing.com/trade stores a real inquiry in Firestore (and sends a real email). Do not use production to run tests; test leads must be deleted from the Firebase console.

To test safely:

1. Use a local development environment (`npm run dev`) with a test email address configured in `TRADE_INQUIRY_TO_EMAIL`.
2. Use the Resend test domain or a controlled inbox.
3. Do not enter real customer data during testing.
4. Delete test emails after verification.

If you must test on production, coordinate with the email recipient so the test submission is expected and can be deleted.
