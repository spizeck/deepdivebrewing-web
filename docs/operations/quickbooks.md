# QuickBooks Online Integration

Operational guide for the QuickBooks Online (QBO) connection foundation
(issue #161). This covers connecting the brewery's QuickBooks company,
keeping sandbox and production strictly separated, and operating the
integration day to day.

**Scope:** connection foundation only — OAuth, token lifecycle, webhook
receipts, entity discovery, and accounting-mapping configuration. No
bookkeeping is posted yet (see
[What is deliberately not built](#what-is-deliberately-not-built)).

## Architecture at a glance

| Concern | Design |
| --- | --- |
| OAuth flow | Intuit authorization-code flow, `com.intuit.quickbooks.accounting` scope only. `POST /api/admin/quickbooks/connect` (admin-auth) issues the authorize URL and a one-time state; `GET /api/admin/quickbooks/callback` consumes it. |
| OAuth `state` | 256-bit random, persisted in `qboOauthStates/{state}`, 10-minute TTL, single-use (consumed inside a transaction), bound to the initiating admin uid and the configured environment, and cross-checked against an `httpOnly` cookie so the callback must arrive in the same browser. The callback also re-verifies that the initiating admin's `adminUsers` record is still active before exchanging the code — an admin disabled mid-flow cannot complete the connection. |
| Token storage | Access and refresh tokens are AES-256-GCM encrypted (`lib/qbo-crypto.ts`, key from `QBO_TOKEN_ENCRYPTION_KEY`) and stored only in `qboConnections/{environment}` — deny-all to Firebase clients. Tokens never appear in API responses, logs, or audit records. |
| Token refresh | `getQuickBooksAccessToken()` (`lib/qbo-tokens.ts`) is the single acquisition point. A short Firestore lease prevents concurrent refresh races; the rotated refresh token Intuit returns always replaces the stored one in the same transaction that clears the lease. An `invalid_grant` response flips the record to `reauthorization_required` — the remedy is reconnecting, not retrying. |
| Environment separation | `QBO_ENVIRONMENT` (`sandbox` \| `production`) is read server-side only and decides the Intuit API host, which credential pair is expected, and which `qboConnections` document is used. The doc id IS the environment, so a preview deployment can never address the production company record — and the stored record's `environment` field is re-verified on every read. |
| API boundary | `lib/qbo-api.ts` is the only module that talks to Intuit's v3 API (`/v3/company/{realmId}`, `minorversion=75`). Raw provider payloads never cross the boundary; callers get canonical shapes or a normalized `QboError`. CompanyInfo responses must report the same realm id the request was made against — a missing or mismatched `Id` fails the operation rather than silently adopting another company's identity. |
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
  entities from the connected company. Selections are validated against
  a live query at save time and bound to the environment and realm id —
  a stale mapping from another company or environment is never applied.
- **Webhooks** require no admin interaction. Deliveries are deduplicated
  by content identity; notifications for a realm other than the
  connected company are recorded but flagged ignored.

## What is deliberately not built

No bookkeeping exists yet — by design. The following are deferred until
the accounting policy is chosen and PR #156 (the Stripe payment tool) is
merged:

- Stripe → QBO Sales Receipt / Invoice + Payment / Deposit creation
- Journal entries, refunds, payout and bank-feed reconciliation
- Automated tax mapping beyond the optional tax-code selection
- Any entity writes to QuickBooks at all — every current API call is
  read-only

The seam for that work is `enqueueAccountingTransaction()`
(`lib/qbo-sync.ts`): a future producer hands it a
`QuickBooksSyncCandidate` (amount, currency, date, customer hints,
purpose, external refs). The sync record's document id is the
deterministic `sourceType:sourceId` identity, so retries and replays can
never post the same financial event twice — QBO entity ids recorded
later are correlation references, not the dedupe mechanism.

## Troubleshooting

| Symptom | Likely cause | Check |
| --- | --- | --- |
| "Not configured" on the admin page | Missing `QBO_*` env vars in this deployment's scope | Vercel env scope (Preview vs Production); redeploy after changes |
| Connect redirects back with `state_expired`/`state_invalid` | OAuth flow took >10 min, or the callback hit a different browser/deployment than the connect request | Retry connect; verify `QBO_REDIRECT_URI` exactly matches the registered URI |
| "Reconnect required" | Grant revoked at Intuit, or refresh token expired from disuse | Reconnect; verify the authorized company on return |
| "Connection check completed" but health shows unavailable | Intuit outage or transient failure | Retry later; check Intuit status if persistent |
| Webhooks never arrive | Wrong endpoint registered, or Vercel protection blocking Intuit | Intuit app's webhook config for the matching environment; Deployment Protection bypass for `/api/webhooks/quickbooks` |
| Mapping save rejected with "does not exist" | Selected entity id isn't in the connected company | Re-load entity lists; the mapping validates against live QBO data |
