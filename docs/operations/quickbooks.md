# QuickBooks Online Integration

Operational guide for the QuickBooks Online (QBO) integration
(issues #161, #179). This covers connecting the brewery's QuickBooks
company, keeping sandbox and production strictly separated, the
DDB-payment Sales Receipt sync, and operating the integration day to
day.

**Scope:** OAuth + token lifecycle, webhook receipts, entity discovery,
accounting-mapping configuration, and one bookkeeping write — gross
Sales Receipts for settled DDB-admin payments. Everything else (refunds,
payouts, fees, journals) remains deferred (see
[What is deliberately not built](#what-is-deliberately-not-built)).

## Architecture at a glance

| Concern | Design |
| --- | --- |
| OAuth flow | Intuit authorization-code flow, `com.intuit.quickbooks.accounting` scope only. `POST /api/admin/quickbooks/connect` (admin-auth) issues the authorize URL and a one-time state; `GET /api/admin/quickbooks/callback` consumes it. |
| OAuth `state` | 256-bit random, persisted in `qboOauthStates/{state}`, 10-minute TTL, single-use (consumed inside a transaction), bound to the initiating admin uid and the configured environment, and cross-checked against an `httpOnly` cookie so the callback must arrive in the same browser. The callback also re-verifies that the initiating admin's `adminUsers` record is still active before exchanging the code — an admin disabled mid-flow cannot complete the connection. |
| Token storage | Access and refresh tokens are AES-256-GCM encrypted (`lib/qbo-crypto.ts`, key from `QBO_TOKEN_ENCRYPTION_KEY`) and stored only in `qboConnections/{environment}` — deny-all to Firebase clients. Tokens never appear in API responses, logs, or audit records. |
| Token refresh | `getQuickBooksAccessToken()` (`lib/qbo-tokens.ts`) is the single acquisition point. A short Firestore lease prevents concurrent refresh races; the rotated refresh token Intuit returns always replaces the stored one in the same transaction that clears the lease. An `invalid_grant` response flips the record to `reauthorization_required` — the remedy is reconnecting, not retrying. |
| Environment separation | `QBO_ENVIRONMENT` (`sandbox` \| `production`) is read server-side only and decides the Intuit API host, which credential pair is expected, and which `qboConnections` document is used. The doc id IS the environment, so a preview deployment can never address the production company record — and the stored record's `environment` field is re-verified on every read. |
| API boundary | `lib/qbo-api.ts` is the only module that talks to Intuit's v3 API (`/v3/company/{realmId}`, `minorversion=75`). Raw provider payloads never cross the boundary; callers get canonical shapes or a normalized `QboError`. The connected-company identity is the `realmId` from the OAuth callback — CompanyInfo is fetched inside that realm context as a health/identity confirmation and display-metadata source only. `CompanyInfo.Id` is provider metadata (a real sandbox Id differs from the realmId), never carried into the canonical shape, and can never replace the realm. |
| Webhooks | `POST /api/webhooks/quickbooks` verifies `intuit-signature` (HMAC-SHA256 over the raw body, keyed by `QBO_WEBHOOK_VERIFIER_TOKEN`) before parsing. Verified notifications are deduplicated by content hash into `qboWebhookReceipts`. No entity sync runs yet — receipts are the durable hook future work consumes. |
| Admin surface | `/admin/integrations/quickbooks` (linked from the admin dashboard QuickBooks card) shows environment, connection status, company name, abbreviated realm id, last health check, and the accounting-mapping panel. |
| Audit + logs | `qbo_connected`, `qbo_disconnected`, `qbo_connection_checked`, `qbo_mapping_updated` audit actions; structured `qbo.*` log events. Neither ever carries tokens, secrets, codes, or provider payloads. |

## Environment separation

Two independent configurations exist — they never share credentials,
redirect URIs, verifier tokens, or companies:

| | Preview / Development | Production |
| --- | --- | --- |
| Intuit app keys | **Development** keys | **Production** keys |
| `QBO_ENVIRONMENT` | `sandbox` | `production` |
| QuickBooks company | Intuit sandbox company | Real DDB QuickBooks company |
| Vercel env scope | Preview (and Development for local) | Production |
| `QBO_REDIRECT_URI` | `https://<preview-host>/api/admin/quickbooks/callback` | `https://deepdivebrewing.com/api/admin/quickbooks/callback` |
| Webhook endpoint | `https://<preview-host>/api/webhooks/quickbooks` | `https://deepdivebrewing.com/api/webhooks/quickbooks` |

`QBO_TOKEN_ENCRYPTION_KEY` may be the same generated value in both scopes
or different per scope — it encrypts this app's Firestore records only;
it is not an Intuit credential.

Failing closed is intentional: an unknown `QBO_ENVIRONMENT`, missing
credentials, a non-https redirect URI outside localhost, or a missing
encryption key all abort the operation rather than guess.

## Sandbox setup (Preview / Development)

All Intuit-side steps happen in the
[Intuit Developer Portal](https://developer.intuit.com) against the app's
**Development** settings — never the Production settings.

1. **Create or open the DDB app.** Sign in to the Intuit Developer Portal
   → Dashboard → create an app (or open the existing Deep Dive Brewing
   app).
2. **Enable the QuickBooks Online Accounting scope.** In the app's
   settings/scopes, select `com.intuit.quickbooks.accounting`. That is
   the only scope this integration requests.
3. **Create or open a sandbox company.** Dashboard → Sandbox → create a
   sandbox QuickBooks Online company (a US or Canada sample company
   works; the entity discovery reads whatever chart of accounts the
   company ships with).
4. **Copy the Development Client ID and Client Secret.** Keys & OAuth →
   Development keys. These go to Vercel, not into the repo.
5. **Register the Development redirect URI.** In the app's Development
   redirect URIs, add the exact callback URL for the deployment,
   e.g. `https://<your-preview-host>/api/admin/quickbooks/callback`.
   Intuit matches redirect URIs exactly — scheme, host, and path must
   all match `QBO_REDIRECT_URI`. For local development,
   `http://localhost:3000/api/admin/quickbooks/callback` is also
   accepted by Intuit.
6. **Add the Development webhook endpoint.** In the app's Development
   webhooks section, subscribe to `https://<preview-host>/api/webhooks/quickbooks`
   and select the entity events worth receiving (Customer, Item,
   Account, Payment, SalesReceipt, Invoice are the relevant set for
   future accounting work).
7. **Copy the Development webhook verifier token.** Shown on the same
   webhooks settings page. Set it as `QBO_WEBHOOK_VERIFIER_TOKEN`.
8. **Set the Vercel environment variables** (Project → Settings →
   Environment Variables), scoped to **Preview** (and **Development** if
   you want local dev):

   | Variable | Value |
   | --- | --- |
   | `QBO_ENVIRONMENT` | `sandbox` |
   | `QBO_CLIENT_ID` | Development client id |
   | `QBO_CLIENT_SECRET` | Development client secret |
   | `QBO_REDIRECT_URI` | The exact URI from step 5 |
   | `QBO_WEBHOOK_VERIFIER_TOKEN` | The verifier token from step 7 |
   | `QBO_TOKEN_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

   For local dev, put the same values in `.env.local` (see
   `.env.local.example`) with a localhost redirect URI.
9. **Vercel Deployment Protection.** If the project protects preview
   deployments, add a narrow bypass for the OAuth callback and webhook
   paths — Protection Bypass for Automation scoped to
   `/api/admin/quickbooks/callback` and `/api/webhooks/quickbooks` (or
   the smallest path/host rule Vercel offers). Do not disable preview
   protection globally. The callback must be reachable by the admin's
   browser after Intuit's redirect; the webhook must be reachable by
   Intuit's servers unauthenticated — it authenticates via signature,
   not Vercel auth.
10. **Connect the sandbox company.** Sign in to `/admin` on the preview
    deployment → QuickBooks card → Connect QuickBooks → authorize the
    **sandbox** company at Intuit. The page should return with
    "QuickBooks connected" and show the sandbox company name. Use **Test
    connection** to run a live CompanyInfo check.

Verify the integration boundary while testing:

- Browser dev tools → network: no response body may contain
  `access_token`, `refresh_token`, `accessToken`, or `refreshToken`
  values.
- Firestore console: `qboConnections/sandbox` contains only
  `accessTokenEnc`/`refreshTokenEnc` envelopes (`v1.…`), never plaintext.

### Verified against a real Intuit sandbox

This flow has been exercised end to end on a preview deployment with
Intuit **Development** credentials and a US sandbox company:

- OAuth consent completed and the callback returned `qbo=connected`; the
  connected state, company name, and abbreviated realm persist and
  display correctly.
- **Test connection** succeeded and health shows healthy.
- The accounting-mapping UI loaded real sandbox entities (accounts,
  items, customers, payment methods, tax codes).
- A signed Intuit webhook delivery was accepted: signature verified,
  connected realm recognized, receipt persisted
  (`qbo.webhook.processed` — `received=1 recorded=1 duplicates=0
  ignoredRealms=0`).

Duplicate webhook delivery is covered by automated tests; a real Intuit
resend was not performed manually.

## Production setup

Do this only when the integration is ready for the real company, and
always with **Production** app settings and **Production** Vercel scope.

1. In the Intuit Developer Portal, complete whatever app profile
   requirements Intuit lists for production access (app profile, terms,
   host/verifier URLs — Intuit gates production keys on these).
2. Register the **Production** redirect URI:
   `https://deepdivebrewing.com/api/admin/quickbooks/callback`.
3. Add the **Production** webhook endpoint:
   `https://deepdivebrewing.com/api/webhooks/quickbooks` with the same
   entity selections, and copy the **Production** verifier token.
4. Set the same six variables in Vercel scoped to **Production**, using
   the **Production** client id/secret and
   `QBO_ENVIRONMENT=production`.
5. Redeploy production (env changes never reach already-deployed
   builds).
6. Connect the real DDB QuickBooks company from `/admin` on production
   and confirm the company name shown is actually Deep Dive Brewing's —
   the connection records which realm the OAuth flow selected, so a
   wrong-company authorization is visible immediately.

Never reuse Development credentials in Production scope or vice versa:
the realm that a sandbox credential can authorize cannot be the
production company, and vice versa — but the separation exists so a
misconfiguration fails closed instead of posting to the wrong books.

## Day-to-day operations

- **Test connection** calls QBO CompanyInfo through the stored
  credentials (refreshing the access token first if needed) and records
  the outcome as the connection's last health check. There is no
  background polling.
- **Reconnect** re-runs the OAuth flow. Use it when the page shows
  "Reconnect required" (Intuit revoked or expired the grant — e.g. the
  refresh token aged out after ~100 days of disuse) or when the
  authorized company must change.
- **Disconnect** requires confirmation, asks Intuit to revoke the grant,
  and deletes all credential material locally. The connection record
  keeps only historical metadata; webhook receipts and future sync
  records are intentionally preserved.
- **Accounting mapping** selects real Account/Item/Customer/TaxCode
  entities from the connected company — see
  [Accounting mapping](#accounting-mapping) for the required fields and
  how to verify them.
- **Webhooks** require no admin interaction. Deliveries are deduplicated
  by content identity; notifications for a realm other than the
  connected company are recorded but flagged ignored.

## Sales Receipt sync (DDB payments only)

Implemented in #179 per the
[accounting design](../architecture/quickbooks-accounting-sync.md).
Exactly one thing is posted to QuickBooks: **one gross Sales Receipt per
settled DDB-admin payment, deposited to the mapped Stripe clearing
account.**

### What qualifies

A payment qualifies only through **positive DDB identity** — a canonical
record in the app's own `payments` collection that reached `paid`
through the normal Stripe-verified path. The worker re-verifies the
canonical Checkout Session before writing (session belongs to the same
internal payment id, `complete` + `paid`, amount and currency match the
stored record).

Ollie/Spreedly wholesale charges and every other foreign Stripe
activity can never qualify: they have no `payments/` record, no
checkout-session metadata pointing at one, and no sync record is ever
enqueued for them. Ollie owns wholesale invoicing end to end — posting
for it would double-count revenue.

### What posts

| Field | Value |
| --- | --- |
| Entity | `SalesReceipt` — never Invoice + Payment, never a Deposit |
| Amount | **Gross** customer charge (`amountMinor / 100`). Stripe fee/net are not part of this leg |
| Date | `TxnDate` = the payment's `paidAt`, not processing time |
| Account | `DepositToAccountRef` = mapped Stripe clearing/balance account (e.g. `Stripe Balance`) — never Undeposited Funds, never the bank, never hardcoded |
| Item | `ItemRef` = mapped income item by purpose: tour (`brewery_tour`, `additional_guests`, `private_tour`), tasting (`brewery_tour_tasting`), other (`other`) |
| Customer | `CustomerRef` = mapped generic customer |
| Tax | No `TaxCodeRef`; `GlobalTaxCalculation: "NotApplicable"` sent for non-US companies, omitted for US (the field is required there and rejected here). Tax policy is #184 |
| Correlation | `PrivateNote` carries `ddb:<paymentId>` + Stripe PI/charge refs; `DocNumber` = `DDB-…` derived from the payment id |

### Accounting mapping

Configure it from `/admin/integrations/quickbooks` → **Configure
mapping**. Every selection is a live entity of the connected company —
the save validates each id against a fresh entity query and rejects
anything that does not exist, is inactive, or belongs to the wrong
entity type. The stored mapping is bound to the environment and realm
id, so a mapping saved against another company or environment is never
applied.

| Field | Required | Used for |
| --- | --- | --- |
| **Stripe clearing account** | Required | `DepositToAccountRef` — holds gross receipts until Stripe payouts reconcile (expected choice: `Stripe Balance`). Never the bank account or Undeposited Funds. |
| **Tour income item** | Required | Line `ItemRef` for `brewery_tour`, `additional_guests`, `private_tour` |
| **Tasting income item** | Required | Line `ItemRef` for `brewery_tour_tasting` |
| **Other income item** | Required | Line `ItemRef` for `other` |
| **Generic sales customer** | Required | `CustomerRef` on every sales receipt — one shared customer (e.g. `Stripe Checkout`); per-customer records are deliberately not created |
| **Tax code** | Optional | Leave unset until the Curaçao tax treatment is confirmed with the accountant (#184) |

All five required fields must be selected before a save succeeds — a
partial mapping cannot be stored, and the panel calls out any missing
required fields on a stored mapping that predates the requirement. The
stored field names are unchanged from the original configuration model
(e.g. the generic sales customer is stored as `fallbackCustomerId`) —
only the labels were finalized, so an existing saved mapping needs no
migration.

A payment whose `purpose` matches none of the rows above lands in
`needs_attention` rather than posting to a generic item.

To verify selections after saving: the panel lists the resolved entity
names — confirm each is the intended QBO record. Because the save
rejects stale or inactive ids, a shown name is a live entity at save
time; if a mapped entity is deleted or deactivated in QBO later, the
next posting lands in `needs_attention` instead of posting to the wrong
place.

### Lifecycle and retry

- On a canonical `paid` commit (webhook or manual refresh) the app
  enqueues a durable `qboSyncRecords/{environment}:stripe_payment:{paymentId}`
  record and attempts the write inline.
- `synced` — done; replays return the stored entity id. `failed` —
  transient provider/Stripe/token failure, safe to retry.
  `needs_attention` — a human must fix something first (mapping missing
  or incomplete, purpose unmapped, canonical mismatch, QBO validation
  rejection).
- A `syncing` claim carries a short lease; a stale claim is reclaimed,
  and the worker always queries for the `ddb:<paymentId>` correlation
  marker before creating — a write that landed but whose response was
  lost is adopted, never duplicated.
- There is **no automatic retry sweep yet** (#183). To requeue a
  `failed` or `needs_attention` record after fixing the cause, set its
  `status` back to `pending` in Firestore — the next trigger or manual
  call picks it up.
- QBO failures never affect the payment: it stays `paid`, and nothing
  customer-facing implies the card charge failed.

### No backfill

Only payments that reach `paid` **after** this code is deployed produce
sync records. Historical paid payments — including the live `$5.00`
pre-flight test — are never posted automatically. Any future backfill
is an explicit, separately reviewed admin action.

## What is deliberately not built

- Refund posting (`RefundReceipt` mirroring the original lines) — #180;
  Stripe Dashboard refunds remain invisible to the app
- Stripe payout posting, Mercury deposit creation, clearing/balance
  reconciliation, and fee accounting — #181 (mixed Ollie+DDB payouts
  make this a distinct design problem)
- Automatic retry sweep / admin sync-status surface — #183
- Tax posting — #184 (Curaçao tax policy undecided)
- Journal entries or any other entity writes

## Troubleshooting

### Intuit transaction IDs (`intuit_tid`)

Every Intuit API and OAuth response carries an `intuit_tid` response
header — Intuit's per-request correlation id. The app captures it
server-side at the provider boundary (`lib/qbo-api.ts`,
`lib/qbo-tokens.ts`):

- successful CompanyInfo and entity-discovery calls log it as
  `correlationId` on `qbo.api.companyinfo` / `qbo.api.entities`
  (one line per operation, not per query page);
- token refreshes log it on `qbo.token.refreshed`;
- any failed provider call keeps it on the normalized `QboError`, which
  `logError`/`logWarn` emit as `error.correlationId` automatically.

When Intuit support asks about a specific request, grep Vercel logs for
the `qbo.*` event and quote the `correlationId`. It is safe operational
metadata — a request correlation id, not authentication material — and
it is never sent to the browser.

| Symptom | Likely cause | Check |
| --- | --- | --- |
| "Not configured" on the admin page | Missing `QBO_*` env vars in this deployment's scope | Vercel env scope (Preview vs Production); redeploy after changes |
| Connect redirects back with `state_expired`/`state_invalid` | OAuth flow took >10 min, or the callback hit a different browser/deployment than the connect request | Retry connect; verify `QBO_REDIRECT_URI` exactly matches the registered URI |
| "Reconnect required" | Grant revoked at Intuit, or refresh token expired from disuse | Reconnect; verify the authorized company on return |
| "Connection check completed" but health shows unavailable | Intuit outage or transient failure | Retry later; check Intuit status if persistent |
| Webhooks never arrive | Wrong endpoint registered, or Vercel protection blocking Intuit | Intuit app's webhook config for the matching environment; Deployment Protection bypass for `/api/webhooks/quickbooks` |
| Mapping save rejected with "does not exist" | Selected entity id isn't in the connected company | Re-load entity lists; the mapping validates against live QBO data |
