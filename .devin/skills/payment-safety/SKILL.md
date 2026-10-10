---
name: payment-safety
description: Safety doctrine for payment integrations (Stripe, Sentoo, provider adapters) — webhook verification, idempotency, refund validation, transaction integrity, duplicate-charge prevention, audit trails, and sensitive payment data. Use whenever a task touches payment initiation, webhooks, refunds, reconciliation, checkout flows, or provider API calls. Never perform real financial operations autonomously — they require explicit human authorization.
---

# Payment safety

Non-negotiable rules for code that moves money. Distilled from the
production payment architectures in this ecosystem. **The repository's
own payment boundary and provider adapter are authoritative — this
skill is the review standard, not a redesign mandate.**

## Trust boundary

- **Authoritative amounts come from server-side application state,
  always.** Browser input never supplies amount or currency — the
  server derives them from its own records at initiation. A
  client-supplied amount is a bug class, not a feature.
- **Provider responses and redirects are never evidence of payment.**
  A Checkout URL, `success` return page, query parameter, or create
  response is UX only. Money becomes real only through
  provider-authenticated evidence: a signature-verified webhook's
  re-fetched object, or an authenticated status fetch for providers
  without signed webhooks.
- **A webhook delivery is a hint, not a fact.** Even a verified event
  is used only to locate the object id — canonical state is re-fetched
  before any state change.
- **Secrets are server-only.** Provider secret keys, webhook secrets,
  and merchant credentials never appear in `NEXT_PUBLIC_*`, client
  bundles, logs, error surfaces, docs, or tests.
- **Provider endpoints are allowlisted** — handoff URLs and API hosts
  are validated against the provider's own HTTPS origins; anything else
  fails closed.

## Money representation

- Amounts are **integer minor units** — never floats. Currency is an
  explicit ISO-4217 code carried with every amount and normalized
  before comparison.

## State ownership

- **The application owns the payment record** — a durable internal
  object with its own lifecycle. Provider session/transaction ids are
  opaque correlation references, never the primary key.
- **The initiation snapshot is immutable** — amount/currency recorded
  at create-time is the reconciliation reference; mismatches are
  quarantined, never applied.
- **Settlement is not acceptance.** Reconciling money records a ledger
  fact. Business lifecycle (booking accepted, order fulfilled,
  inventory released) is a separate, explicit decision — a webhook
  never transitions commercial state as a side effect.
- Terminal money states are never silently reopened or unwound by
  automation; contradictions go to an attention/review state.

## Idempotency and duplicates

- **Every initiate/charge/refund call carries an idempotency key**
  derived from a durable internal id. Providers without documented
  idempotency keys get the internal id as a correlation reference, but
  a correlation reference does not make the provider call idempotent:
  if a charge succeeds at the provider while its response is lost, no
  provider reference exists to reuse and a blind retry can charge or
  refund twice. After an ambiguous outcome, reconcile the attempt at
  the provider by the correlation reference before retrying, or move it
  to manual review. Do not issue another create call until the prior
  outcome is known.
- **Preserve pinned provider versions.** Never upgrade a provider SDK
  or API version as a side effect of unrelated work — version changes
  are deliberate, reviewed migrations, not defaults.
- **Deliveries dedup at two levels**: a provider-event table keyed on
  `(provider, eventId)` anchors delivery; the settled-money record keys
  on `(provider, providerRef)` so different events for the same payment
  post money exactly once.
- **Refunds link to the original payment** — partial refunds are
  append-only rows referencing the settled entry, never edits to it.

## Concurrency

- Status transitions run under a row-level lock on the internal record.
- **Provider API calls never run inside the database transaction** —
  lock, read, unlock, call, lock, apply.
- Event disposition + status transition + audit record commit
  atomically — a crash never leaves "processed but not applied".
- Out-of-order/replayed events converge: late observations against a
  terminal state are no-ops; provider-evidence contradicting recorded
  money escalates rather than rewriting.
- Webhook responses: durable outcomes → 2xx; authenticity failure →
  400; transient internal failure → 5xx (let the provider retry).

## Observability and data handling

- Structured events at each transition with internal-attempt and
  provider-reference correlation — using the app's existing logger, not
  a parallel one.
- Provider errors normalize behind the adapter boundary (configuration
  / refusal / unavailable with opaque refs) — raw SDK errors and
  provider payloads never propagate: they echo request internals and
  payer PII.
- **Never log or store** PAN, CVC, full tokens, webhook secrets, or raw
  provider payloads. Safe card metadata (brand/last4/expiry) may persist
  for display; nothing else of the instrument touches our storage.

## Testing

- Adapters test against injected transport/mocked SDK — no network, no
  credentials, no provider sandbox in unit tests.
- Webhook tests must cover: valid signature path, invalid/missing
  signature → 400 with no state change, duplicate delivery convergence,
  out-of-order events, amount/currency mismatch quarantine, unknown
  reference rejection, and burst delivery under concurrency.

## Hard boundary

**Never perform autonomous financial operations** — no real charges,
refunds, payouts, Connect operations, live-mode API calls, or webhook
endpoint changes without explicit human authorization, even when a
credential is available. Sandbox/test-mode operations only, and only
when the task calls for them.
