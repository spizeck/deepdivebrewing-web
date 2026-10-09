# QuickBooks Online Integration

Operational guide for the QuickBooks Online (QBO) integration
(issues #161, #179, #183). This covers connecting the brewery's
QuickBooks company, keeping sandbox and production strictly separated,
the DDB-payment Sales Receipt sync, and operating the integration day
to day.

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
| Sync worker | `lib/qbo-sync.ts` processes durable `qboSyncRecords` under a short lease; `lib/qbo-sweep.ts` is the bounded sweep — missed-enqueue recovery plus due-record processing — invoked by `GET /api/cron/qbo-sweep` (Vercel Cron, `CRON_SECRET` bearer) and by the admin "Run sync sweep" action (`POST /api/admin/quickbooks/sync`). |
| Admin surface | `/admin/integrations/quickbooks` (linked from the admin dashboard QuickBooks card) shows environment, connection status, company name, abbreviated realm id, last health check, the accounting-mapping panel, and the sync operations panel — counts by status, paused state, recent failed/needs-attention records, and a per-record manual retry. |
| Audit + logs | `qbo_connected`, `qbo_disconnected`, `qbo_connection_checked`, `qbo_mapping_updated`, `qbo_sync_requeued`, `qbo_sweep_triggered` audit actions; structured `qbo.*` log events. Neither ever carries tokens, secrets, codes, or provider payloads. |

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
   `.env.local.example`) with a localhost redirect URI. Vercel Cron only
   runs on the **Production** deployment, so `CRON_SECRET` (and
   optionally `QBO_SWEEP_LOOKBACK_HOURS`) belong to the production setup
   below — a deployment without them simply rejects cron calls, which is
   the intended fail-closed behavior for previews.
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
5. Set **`CRON_SECRET`** (Production scope) to a generated secret — the
   QBO sync sweep cron authenticates with it, and the route fails closed
   without it:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Optionally set `QBO_SWEEP_LOOKBACK_HOURS` if the default 72-hour
   missed-enqueue window should differ — it also controls how far back
   older settled payments are picked up (see
   [Backfill bounds](#backfill-bounds)).
6. Redeploy production (env changes never reach already-deployed
   builds). After the first deploy with the cron configured, confirm the
   `qbo-sweep` job appears under Project → Settings → Crons and that the
   first run logs `qbo.sweep.completed`.
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
[accounting design](../architecture/quickbooks-accounting-sync.md), and
extended to the cash rail in #206. Exactly one thing is posted to
QuickBooks: **one gross Sales Receipt per settled DDB-admin payment,
deposited to the account that matches the payment's rail** — the mapped
Stripe clearing account for `card` payments (`stripe_payment` source
type), the mapped cash deposit account for `cash` payments
(`cash_payment` source type).

### What qualifies

A payment qualifies only through **positive DDB identity** — a canonical
record in the app's own `payments` collection that reached `paid`. The
sync record's source type must match the payment's own `paymentMethod`
(a mismatch lands in `needs_attention`, so a stale or tampered sync
record can never steer a payment into the wrong account). For the card
rail the worker additionally re-verifies the canonical Checkout Session
before writing (session belongs to the same internal payment id,
`complete` + `paid`, amount and currency match the stored record). For
the cash rail there is no provider — the server's own paid record, which
only an authorized admin could create, is the whole of the verification.

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
| Account | `DepositToAccountRef` by rail — card: mapped Stripe clearing/balance account (e.g. `Stripe Balance`); cash: mapped cash deposit account. Never Undeposited Funds, never the bank, never hardcoded |
| Item | `ItemRef` = mapped income item by purpose: tour (`brewery_tour`, `additional_guests`, `private_tour`), tasting (`brewery_tour_tasting`), other (`other`) |
| Customer | `CustomerRef` = mapped generic customer |
| Payment method | `PaymentMethodRef` = mapped QBO PaymentMethod by rail — the card method (e.g. `Credit Card` or `Stripe`) for card receipts, the cash method (e.g. `Cash`) for cash receipts. Never blank, never inferred from the deposit account |
| Tax | No `TaxCodeRef`; `GlobalTaxCalculation: "NotApplicable"` sent for non-US companies, omitted for US (the field is required there and rejected here). Tax policy is #184 |
| Correlation | `PrivateNote` carries `ddb:<paymentId>` plus the rail — card receipts add Stripe PI/charge refs, cash receipts carry a `Cash payment` label; `DocNumber` = `DDB-…` derived from the payment id |

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
| **Stripe clearing account** | Required | `DepositToAccountRef` for card payments — holds gross receipts until Stripe payouts reconcile (expected choice: `Stripe Balance`). Never the bank account or Undeposited Funds. |
| **Cash deposit account** | Optional | `DepositToAccountRef` for cash payments (e.g. a petty-cash/`Cash on Hand`-style account). Optional at save time so a card-only rollout is never blocked — but a cash payment without one lands in `needs_attention` (`missing_cashDepositAccountId`) instead of posting to a guessed account. |
| **Card payment method** | Required | `PaymentMethodRef` on card sales receipts — pick whichever method the company carries for card/Stripe takings (e.g. `Credit Card` or `Stripe`). Receipts never post with a blank payment method. |
| **Cash payment method** | Optional | `PaymentMethodRef` on cash sales receipts (expected choice: the company's `Cash`). Optional at save time; a cash payment without one lands in `needs_attention` (`missing_cashPaymentMethodId`). |
| **Tour income item** | Required | Line `ItemRef` for `brewery_tour`, `additional_guests`, `private_tour` |
| **Tasting income item** | Required | Line `ItemRef` for `brewery_tour_tasting` |
| **Other income item** | Required | Line `ItemRef` for `other` |
| **Generic sales customer** | Required | `CustomerRef` on every sales receipt — one shared customer (e.g. `Stripe Checkout`); per-customer records are deliberately not created |
| **Tax code** | Optional | Leave unset until the Curaçao tax treatment is confirmed with the accountant (#184) |

All six required fields must be selected before a save succeeds — a
partial mapping cannot be stored, and the panel calls out any missing
required fields on a stored mapping that predates the requirement (a
mapping saved before the payment-method fields existed reports the card
payment method as missing until it is picked). The stored field names
are unchanged from the original configuration model (e.g. the generic
sales customer is stored as `fallbackCustomerId`) — only the labels
were finalized, so an existing saved mapping needs no migration. The
cash deposit account and cash payment method are the optional
operational fields: when either is provided the save validates it
against live entities like every other selection.

A payment whose `purpose` matches none of the rows above lands in
`needs_attention` rather than posting to a generic item.

To verify selections after saving: the panel lists the resolved entity
names — confirm each is the intended QBO record. Because the save
rejects stale or inactive ids, a shown name is a live entity at save
time; if a mapped entity is deleted or deactivated in QBO later, the
next posting lands in `needs_attention` instead of posting to the wrong
place.

### Lifecycle and retry

- On a canonical `paid` commit — webhook/manual-refresh for the card
  rail, the create transaction itself for cash — the app enqueues a
  durable `qboSyncRecords/{environment}:{sourceType}:{paymentId}` record
  (`stripe_payment` or `cash_payment` — the source type is derived from
  the payment's own `paymentMethod`, never supplied by a caller) and
  attempts the write inline. The inline attempt keeps the
  common path instant; everything after it is the sweeps' business.
- `synced` — done; replays return the stored entity id. `failed` —
  transient provider/Stripe/token failure; the record retries on a
  bounded backoff schedule. `needs_attention` — a human must fix
  something first (mapping missing or incomplete, purpose unmapped,
  canonical mismatch, QBO validation rejection, or the retry budget
  spent).
- A `syncing` claim carries a short lease; a stale claim is reclaimed,
  and the worker always queries for the `ddb:<paymentId>` correlation
  marker before creating — a write that landed but whose response was
  lost is adopted, never duplicated.
- QBO failures never affect the payment: it stays `paid`, and nothing
  customer-facing implies the card charge failed.

#### Backoff schedule

Each retryable failure records `attempts`, `lastAttemptAt`,
`nextAttemptAt`, `lastErrorCode`, `lastErrorMessage`, and the Intuit
correlation id when one exists. `nextAttemptAt` is scheduled from a
fixed table indexed by the attempt that just ran:

| Attempt | Delay |
| --- | --- |
| 1 | 1 minute |
| 2 | 5 minutes |
| 3 | 30 minutes |
| 4 | 2 hours |
| 5 | 4 hours |
| 6–8 | 8 hours |

After 8 attempts (`QBO_SYNC_MAX_ATTEMPTS` in `lib/qbo-sync.ts`) the
record parks in `needs_attention` with `lastErrorCode =
"retry_exhausted"`. Validation, permission, and configuration failures
skip the backoff entirely — retrying unchanged cannot help, so they go
straight to `needs_attention` on the first attempt.

#### The sync sweep (cron)

`GET /api/cron/qbo-sweep` is scheduled in `vercel.json` (daily, `17 5
* * *` — a daily schedule is the most frequent cron every Vercel plan
accepts; on a Pro plan the cadence can be tightened if faster automatic
recovery is wanted). Vercel attaches `Authorization: Bearer
$CRON_SECRET`; the route verifies it with a constant-time compare and
fails closed when the variable is unset — there is no public
unauthenticated path.

One run performs three bounded phases (`lib/qbo-sweep.ts`):

1. **Missed-enqueue recovery** — `payments` documents whose `paidAt`
   falls inside the lookback window (default 72 h, `QBO_SWEEP_LOOKBACK_HOURS`,
   max 720 h) and reached `paid`/`refunded` get a sync record if none
   exists. Enqueue is idempotent on the deterministic sync id, so a
   payment that already has one is a no-op. The scan is positive
   identity only — it reads the app's own `payments` collection, so
   Ollie/foreign Stripe activity can never match.
2. **Connection gate** — if the connection is `disconnected` or
   `reauthorization_required` (or missing), processing is skipped and
   the run reports `paused`. Enqueue still ran first: durable intent is
   cheap and survives the outage.
3. **Due-record processing** — `pending`/`failed` records whose
   `nextAttemptAt` has passed, plus stale `syncing` claims, are
   processed oldest-first up to `QBO_SWEEP_MAX_RECORDS` (10) per run.
   Each run scans one 500-record page of the status-filtered set in
   `syncId` (document-id) order, resuming from a per-environment cursor
   in `qboSweepState` that wraps once the scan reaches the end — a full
   page of not-due records can't starve a due record behind the cap.

Concurrent invocations are safe: the claim transaction gives each
record to exactly one claimant; a second sweeper sees `syncing` and
moves on.

The same sweep runs on demand from the QuickBooks admin page ("Run
sync sweep" → `POST /api/admin/quickbooks/sync`, audited as
`qbo_sweep_triggered`) — use it after reconnecting or fixing a mapping
instead of waiting for the next cron.

#### Authorization loss and reconnect

When Intuit stops honoring the grant (`invalid_grant`), the token layer
flips the connection to `reauthorization_required`. From then on:

- the worker's pause gate refuses to claim records — attempts are not
  consumed and nothing is discarded;
- the admin page shows "Reconnect required" and the sync panel shows
  paused;
- reconnecting (`Connect QuickBooks` again) restores the grant and the
  OAuth callback pulls every record that failed with
  `authorization_expired` forward to due-now, so the next sweep drains
  the backlog without waiting out a stale backoff.

#### Manual retry

After fixing the cause (mapping saved, reconnect completed, upstream
record corrected), click **Retry** on the record in the sync panel —
`POST /api/admin/quickbooks/sync/retry` (audited `qbo_sync_requeued`)
returns the record to `pending` with a fresh attempt budget and
processes it inline for immediate feedback. Only `failed` and
`needs_attention` records are eligible, the record must belong to the
configured environment, and every worker gate still applies: canonical
Stripe re-verification, mapping validation, realm/environment binding,
and marker idempotency.

### Backfill bounds

The missed-enqueue sweep picks up every qualifying payment whose
`paidAt` is inside the lookback window — 72 h by default, set by
`QBO_SWEEP_LOOKBACK_HOURS` and hard-capped at 30 days. The window is a
time bound, not a deployment cutoff: a payment that settled before this
feature shipped is still enqueued and posted when its `paidAt` falls
inside the window, and raising `QBO_SWEEP_LOOKBACK_HOURS` deliberately
widens how far back the scan reaches. Only payments older than the
configured window are skipped — a record like the live `$5.00`
pre-flight test stays unposted only while it remains outside it. A
backfill beyond the 30-day cap remains an explicit, separately reviewed
admin action, not a sweep configuration change.

## What is deliberately not built

- Refund posting (`RefundReceipt` mirroring the original lines) — #180;
  Stripe Dashboard refunds remain invisible to the app. The sweeps
  already enqueue `refunded` payments so the original Sales Receipt
  exists, but no reversal entity is posted. For the card rail Stripe
  payout reconciliation surfaces the difference; for a **cash** refund
  there is no external signal at all — the receipt stays in the cash
  deposit account until someone reverses it by hand in QBO. When staff
  record a cash refund, reverse the matching Sales Receipt (`PrivateNote`
  marker `ddb:<paymentId>`) in QuickBooks the same day.
- Stripe payout posting, Mercury deposit creation, clearing/balance
  reconciliation, and fee accounting — #181 (mixed Ollie+DDB payouts
  make this a distinct design problem)
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
| Sync record stuck in `failed` | Retryable provider/Stripe outage still ongoing, or `nextAttemptAt` not yet due | Check `lastErrorCode`/`lastErrorMessage` in the sync panel; the next sweep retries automatically |
| Sync record in `needs_attention` | Mapping/purpose/canonical mismatch, or `retry_exhausted` | Fix the cause (mapping, record, reconnect), then **Retry** in the sync panel |
| Cash payment stuck at `needs_attention` with `missing_cashDepositAccountId` | No cash deposit account is mapped — posting fails closed rather than guessing | Set **Cash deposit account** in the accounting-mapping panel, then **Retry** the record |
| Record at `needs_attention` with `missing_cardPaymentMethodId` | A stored mapping predates the payment-method fields | Pick **Card payment method** in the accounting-mapping panel, save, then **Retry** the record |
| Cash record at `needs_attention` with `missing_cashPaymentMethodId` | No cash payment method is mapped | Set **Cash payment method** in the accounting-mapping panel, then **Retry** the record |
| Sync panel shows paused / records not draining | Connection `reauthorization_required` or `disconnected` | Reconnect QuickBooks; the backlog resumes on the next sweep (or "Run sync sweep") |
| Cron runs but nothing posts | `CRON_SECRET` unset in the deployment (route fails closed) | Vercel env scope; check for `401` on the cron invocation and `qbo.sweep.*` log lines |
| Same payment appears twice in QBO | Should never happen — report it | `qboSyncRecords` for the payment id; `PrivateNote` marker `ddb:<paymentId>` on the receipts |
