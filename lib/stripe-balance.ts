import "server-only";
import { getStripeClient } from "@/lib/stripe";
import { QboError } from "@/lib/qbo-errors";
import { logInfo } from "@/lib/log";
import type { StripeBalanceTxnFacts } from "@/lib/qbo-recon-common";

// Stripe balance/balance-transaction read boundary (issue #181). The only
// module that touches the balance-reporting surfaces of the Stripe SDK:
// callers get back canonical fact shapes or a normalized QboError — raw
// provider objects and SDK errors never leave this module. Reads only —
// nothing here initiates, refunds, or moves anything.

// Balance-transaction history is read in bounded pages so an admin-triggered
// run can never scan unrestricted account history. 25 pages × 100 covers
// ~2,500 movements inside the (max 180-day) window; a fuller window reports
// `truncated` rather than fetching forever.
export const STRIPE_BALANCE_TXN_PAGE_SIZE = 100;
export const STRIPE_BALANCE_TXN_MAX_PAGES = 25;

function stripeReadFailed(operation: string): QboError {
  return new QboError(
    `Stripe ${operation} failed — try again shortly.`,
    "unavailable",
    502
  );
}

function canonicalizeBalanceTransaction(
  raw: Record<string, unknown>
): StripeBalanceTxnFacts | null {
  const id = typeof raw.id === "string" ? raw.id : "";
  const type = typeof raw.type === "string" ? raw.type : "";
  const currency =
    typeof raw.currency === "string" ? raw.currency.toUpperCase() : "";
  if (
    !id ||
    !type ||
    !currency ||
    typeof raw.amount !== "number" ||
    typeof raw.fee !== "number" ||
    typeof raw.net !== "number"
  ) {
    return null;
  }
  return {
    id,
    type,
    amountMinor: raw.amount,
    feeMinor: raw.fee,
    netMinor: raw.net,
    currency,
    status: typeof raw.status === "string" ? raw.status : "unknown",
    source: typeof raw.source === "string" ? raw.source : undefined,
    createdMs:
      typeof raw.created === "number" ? raw.created * 1000 : undefined,
    availableOnMs:
      typeof raw.available_on === "number"
        ? raw.available_on * 1000
        : undefined,
  };
}

// Bounded, paginated read of every balance movement created inside the
// window — charge gross/fee/net, refunds, payouts, adjustments, and
// account-level entries alike, for the *whole shared account* (Ollie and
// DDB lanes both appear; attribution is the caller's concern).
export async function listStripeBalanceTransactions(input: {
  createdGteSec: number;
  createdLtSec: number;
  maxPages?: number;
}): Promise<{
  txns: StripeBalanceTxnFacts[];
  pages: number;
  truncated: boolean;
}> {
  const client = getStripeClient();
  const maxPages = input.maxPages ?? STRIPE_BALANCE_TXN_MAX_PAGES;
  const txns: StripeBalanceTxnFacts[] = [];
  let startingAfter: string | undefined;
  let pages = 0;
  let truncated = false;
  try {
    for (;;) {
      const page = await client.balanceTransactions.list({
        created: { gte: input.createdGteSec, lt: input.createdLtSec },
        limit: STRIPE_BALANCE_TXN_PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      pages += 1;
      for (const raw of page.data) {
        const txn = canonicalizeBalanceTransaction(
          raw as unknown as Record<string, unknown>
        );
        if (txn) txns.push(txn);
      }
      if (!page.has_more || pages >= maxPages) {
        truncated = page.has_more;
        break;
      }
      startingAfter = page.data[page.data.length - 1]?.id;
      if (!startingAfter) break;
    }
  } catch {
    throw stripeReadFailed("balance transaction read");
  }
  logInfo("stripe.recon.balance_txns", { pages, count: txns.length, truncated });
  return { txns, pages, truncated };
}

// The Stripe account's actual cash position — available and pending totals
// in the run currency. This is the ledger side reconciliation compares
// against the QBO clearing account (which intentionally retains funds).
export async function fetchStripeBalanceTotals(
  currency: string = "usd"
): Promise<{ availableMinor: number; pendingMinor: number; currency: string }> {
  const want = currency.toLowerCase();
  let balance: { available?: unknown; pending?: unknown };
  try {
    balance = (await getStripeClient().balance.retrieve()) as unknown as {
      available?: unknown;
      pending?: unknown;
    };
  } catch {
    throw stripeReadFailed("balance read");
  }
  const sum = (entries: unknown): number =>
    Array.isArray(entries)
      ? entries.reduce((total, entry) => {
          const e = entry as { amount?: unknown; currency?: unknown };
          return typeof e?.amount === "number" && e.currency === want
            ? total + e.amount
            : total;
        }, 0)
      : 0;
  return {
    availableMinor: sum(balance.available),
    pendingMinor: sum(balance.pending),
    currency: want.toUpperCase(),
  };
}

// Charge facts used for enrichment attribution: the PaymentIntent the
// charge belongs to and the `metadata.paymentId` the payment tool writes
// at session creation (propagated onto the PaymentIntent; charge-level
// copies are read defensively when present).
export async function fetchStripeChargeFacts(chargeId: string): Promise<{
  paymentIntentId?: string;
  paymentId?: string;
}> {
  let charge: Record<string, unknown>;
  try {
    charge = (await getStripeClient().charges.retrieve(
      chargeId
    )) as unknown as Record<string, unknown>;
  } catch {
    throw stripeReadFailed("charge read");
  }
  const pi = charge.payment_intent;
  const metadata = charge.metadata;
  return {
    paymentIntentId:
      typeof pi === "string"
        ? pi
        : pi && typeof pi === "object" && typeof (pi as { id?: unknown }).id === "string"
          ? (pi as { id: string }).id
          : undefined,
    paymentId:
      metadata &&
      typeof metadata === "object" &&
      typeof (metadata as Record<string, unknown>).paymentId === "string"
        ? ((metadata as Record<string, unknown>).paymentId as string)
        : undefined,
  };
}

// Refund facts for enrichment: which charge the refund belongs to plus any
// direct identity the refund itself carries.
export async function fetchStripeRefundFacts(refundId: string): Promise<{
  chargeId?: string;
  paymentIntentId?: string;
  paymentId?: string;
}> {
  let refund: Record<string, unknown>;
  try {
    refund = (await getStripeClient().refunds.retrieve(
      refundId
    )) as unknown as Record<string, unknown>;
  } catch {
    throw stripeReadFailed("refund read");
  }
  const charge = refund.charge;
  const pi = refund.payment_intent;
  const metadata = refund.metadata;
  const idOf = (v: unknown): string | undefined =>
    typeof v === "string"
      ? v
      : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string"
        ? (v as { id: string }).id
        : undefined;
  return {
    chargeId: idOf(charge),
    paymentIntentId: idOf(pi),
    paymentId:
      metadata &&
      typeof metadata === "object" &&
      typeof (metadata as Record<string, unknown>).paymentId === "string"
        ? ((metadata as Record<string, unknown>).paymentId as string)
        : undefined,
  };
}

// The fee-arm's canonical read (dormant — see issue #181 fee design): one
// charge plus its linked balance transaction, carrying the authoritative
// gross/fee/net. No fee is ever estimated — Stripe reports it exactly.
export async function fetchStripeChargeBalanceTransaction(
  chargeId: string
): Promise<{
  chargeId: string;
  paymentIntentId?: string;
  paymentId?: string;
  balanceTransactionId?: string;
  amountMinor?: number;
  feeMinor?: number;
  netMinor?: number;
  currency?: string;
  txnCreatedMs?: number;
}> {
  const client = getStripeClient();
  let charge: Record<string, unknown>;
  try {
    charge = (await client.charges.retrieve(
      chargeId
    )) as unknown as Record<string, unknown>;
  } catch {
    throw stripeReadFailed("charge read");
  }
  const pi = charge.payment_intent;
  const metadata = charge.metadata;
  const bt = charge.balance_transaction;
  const btId =
    typeof bt === "string"
      ? bt
      : bt && typeof bt === "object" && typeof (bt as { id?: unknown }).id === "string"
        ? (bt as { id: string }).id
        : undefined;
  const base = {
    chargeId,
    paymentIntentId:
      typeof pi === "string"
        ? pi
        : pi && typeof pi === "object" && typeof (pi as { id?: unknown }).id === "string"
          ? (pi as { id: string }).id
          : undefined,
    paymentId:
      metadata &&
      typeof metadata === "object" &&
      typeof (metadata as Record<string, unknown>).paymentId === "string"
        ? ((metadata as Record<string, unknown>).paymentId as string)
        : undefined,
    balanceTransactionId: btId,
  };
  if (!btId) return base;
  let txn: Record<string, unknown>;
  try {
    txn = (await client.balanceTransactions.retrieve(
      btId
    )) as unknown as Record<string, unknown>;
  } catch {
    throw stripeReadFailed("balance transaction read");
  }
  return {
    ...base,
    amountMinor: typeof txn.amount === "number" ? txn.amount : undefined,
    feeMinor: typeof txn.fee === "number" ? txn.fee : undefined,
    netMinor: typeof txn.net === "number" ? txn.net : undefined,
    currency:
      typeof txn.currency === "string" ? txn.currency.toUpperCase() : undefined,
    txnCreatedMs:
      typeof txn.created === "number" ? txn.created * 1000 : undefined,
  };
}
