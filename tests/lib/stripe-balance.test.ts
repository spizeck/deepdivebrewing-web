import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert";

// Boundary coverage for the Stripe payout read surface: bounded
// pagination of the recent-payout scan and the not-found vs transient
// split on single-payout retrieval. The Stripe client is module-mocked —
// no network, no credentials.

mock.module("server-only", { namedExports: {} });
mock.module("@/lib/log", {
  namedExports: {
    logInfo: () => {},
    logWarn: () => {},
    logError: () => {},
  },
});

interface ListCall {
  created?: { gte?: number };
  limit?: number;
  starting_after?: string;
}

const listCalls: ListCall[] = [];
let listPages: { data: Record<string, unknown>[]; has_more: boolean }[] = [];
let retrieveResult: Record<string, unknown> | null = null;
let retrieveError: unknown = null;

mock.module("@/lib/stripe", {
  namedExports: {
    getStripeClient: () => ({
      payouts: {
        list: async (params: ListCall) => {
          listCalls.push(params);
          const page = listPages.shift();
          if (!page) throw new Error("unexpected extra page fetch");
          return page;
        },
        retrieve: async () => {
          if (retrieveError) throw retrieveError;
          return retrieveResult;
        },
      },
      balanceTransactions: {
        list: async () => ({ data: [], has_more: false }),
      },
    }),
  },
});

function payoutFixture(id: string, created = 1_760_000_000) {
  return {
    id,
    object: "payout",
    status: "paid",
    amount: 1000,
    currency: "usd",
    arrival_date: created + 86_400,
    created,
    livemode: false,
  };
}

beforeEach(() => {
  listCalls.length = 0;
  listPages = [];
  retrieveResult = null;
  retrieveError = null;
});

describe("listRecentStripePayouts", () => {
  it("returns a single page of canonicalized payouts", async () => {
    const { listRecentStripePayouts } = await import("@/lib/stripe-balance");
    listPages = [
      { data: [payoutFixture("po_1"), payoutFixture("po_2")], has_more: false },
    ];
    const { payouts, truncated } = await listRecentStripePayouts({
      createdGteSec: 1_759_000_000,
      limit: 50,
    });
    assert.equal(payouts.length, 2);
    assert.equal(truncated, false);
    assert.equal(payouts[0].id, "po_1");
    assert.equal(payouts[0].amountMinor, 1000);
    assert.equal(payouts[0].currency, "USD");
    assert.equal(payouts[0].livemode, false);
    assert.equal(listCalls.length, 1);
    assert.equal(listCalls[0].limit, 50);
    assert.deepEqual(listCalls[0].created, { gte: 1_759_000_000 });
  });

  it("paginates with starting_after up to maxPages and reports truncation", async () => {
    const { listRecentStripePayouts } = await import("@/lib/stripe-balance");
    listPages = [
      { data: [payoutFixture("po_a")], has_more: true },
      { data: [payoutFixture("po_b")], has_more: true },
      { data: [payoutFixture("po_c")], has_more: true },
    ];
    const { payouts, truncated } = await listRecentStripePayouts({
      createdGteSec: 0,
      limit: 1,
      maxPages: 2,
    });
    assert.equal(payouts.length, 2);
    assert.equal(truncated, true); // a third page exists beyond the cap
    assert.equal(listCalls.length, 2);
    assert.equal(listCalls[1].starting_after, "po_a");
  });

  it("keeps the single-page default for the sweep caller", async () => {
    const { listRecentStripePayouts } = await import("@/lib/stripe-balance");
    listPages = [{ data: [payoutFixture("po_a")], has_more: true }];
    const { payouts, truncated } = await listRecentStripePayouts({
      createdGteSec: 0,
      limit: 50,
    });
    assert.equal(payouts.length, 1);
    assert.equal(truncated, true);
    assert.equal(listCalls.length, 1);
  });
});

describe("fetchStripePayout", () => {
  it("returns canonical facts including livemode", async () => {
    const { fetchStripePayout } = await import("@/lib/stripe-balance");
    retrieveResult = payoutFixture("po_9");
    const payout = await fetchStripePayout("po_9");
    assert.equal(payout?.id, "po_9");
    assert.equal(payout?.livemode, false);
  });

  it("returns null for a payout missing from this account/mode", async () => {
    const { fetchStripePayout } = await import("@/lib/stripe-balance");
    retrieveError = Object.assign(new Error("No such payout"), {
      code: "resource_missing",
      statusCode: 404,
    });
    assert.equal(await fetchStripePayout("po_nope"), null);

    retrieveError = Object.assign(new Error("Not found"), {
      statusCode: 404,
    });
    assert.equal(await fetchStripePayout("po_nope"), null);
  });

  it("normalizes transient failures to a safe unavailable error", async () => {
    const { fetchStripePayout } = await import("@/lib/stripe-balance");
    retrieveError = Object.assign(new Error("socket hangup"), {
      statusCode: 500,
      secretDetail: "sk_live_raw_payload",
    });
    await assert.rejects(
      () => fetchStripePayout("po_9"),
      (error: unknown) => {
        const e = error as { message: string; status?: number };
        assert.equal(e.status, 502);
        assert.equal(e.message.includes("sk_live_raw_payload"), false);
        return true;
      }
    );
  });
});
