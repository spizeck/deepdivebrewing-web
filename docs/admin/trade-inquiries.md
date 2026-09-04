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
5. The server sends an email through **Resend** to the address configured in `TRADE_INQUIRY_TO_EMAIL`.
6. The email's reply-to address is set to the submitter's email.

The email subject is:

```
Trade Inquiry — <Business Name> (<Contact Name>)
```

The email body contains all submitted fields in a simple HTML table.

## Where inquiries are delivered

Inquiries are delivered to the email address set in the `TRADE_INQUIRY_TO_EMAIL` environment variable. There is no admin dashboard inbox for trade inquiries.

> **Note:** The codebase also contains a `tradeLeads` Firestore collection definition and a helper function (`lib/trade-leads.ts`), but the current trade-inquiry form does **not** write submissions to Firestore. If you need a Firestore copy for tracking, contact a developer. This is labeled as **Needs confirmation** for the intended workflow.

## Expected success behavior

After a successful submission:

- The form is replaced with a thank-you message.
- A `trade_form_success` analytics event is recorded (no personal information is included).

## Expected failure behavior

If submission fails:

- The form shows an error message describing the problem.
- A `trade_form_error` analytics event is recorded.
- Common failure reasons include missing required fields, rate limiting, or an email service configuration problem.

## How administrators should respond

1. Monitor the inbox configured in `TRADE_INQUIRY_TO_EMAIL`.
2. Reply directly to the submitter using the reply-to address.
3. Keep business and contact details confidential; do not forward inquiry emails to unauthorized recipients.
4. Track follow-up status in your preferred CRM or email workflow. The website does not currently provide a lead-management interface.

## Privacy considerations

- The form collects business contact information. Treat it as personal/business data.
- Do not add submitted emails to marketing lists without consent.
- Do not store inquiry details in insecure locations.
- Only authorized staff with access to the `TRADE_INQUIRY_TO_EMAIL` inbox should handle inquiries.

## What information must never be sent to analytics

Analytics events are configured to avoid personally identifiable information (PII). The following must **never** be sent to analytics:

- Email addresses.
- Phone numbers.
- Business names tied to an individual.
- Any message text from the form.

The current analytics events (`trade_form_start`, `trade_form_success`, `trade_form_error`) only record the event category, CTA location, and venue type.

## Safe testing procedures

> **Warning:** Submitting the live form on https://deepdivebrewing.com/trade creates a real inquiry email unless the email service is misconfigured. Do not use production to run tests.

To test safely:

1. Use a local development environment (`npm run dev`) with a test email address configured in `TRADE_INQUIRY_TO_EMAIL`.
2. Use the Resend test domain or a controlled inbox.
3. Do not enter real customer data during testing.
4. Delete test emails after verification.

If you must test on production, coordinate with the email recipient so the test submission is expected and can be deleted.
