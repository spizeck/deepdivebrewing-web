import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// The module under test is server-only at runtime (it reaches the Resend
// client); these tests exercise only its pure key/build logic.
mock.module("server-only", { namedExports: {} });

// The module under test is loaded lazily, after the server-only mock
// above is registered (the orchestration tests use the same pattern).
const load = () => import("@/lib/payout-attention");
type Mod = Awaited<ReturnType<typeof load>>;
type PayoutAttentionInput = Parameters<Mod["payoutAttentionKey"]>[0];

const base: PayoutAttentionInput = {
  payoutId: "po_test",
  amountMinor: 19060,
  currency: "USD",
  arrivalDate: "2026-10-15",
  exceptions: [],
  autoApplied: 0,
  autoPending: 0,
};

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const originals = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    originals.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    fn();
  } finally {
    for (const [name, original] of originals) {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  }
}

const ATTENTION_ENV_KEYS = [
  "PAYOUT_ATTENTION_EMAIL",
  "TRADE_NOTIFICATION_EMAIL",
  "TRADE_INQUIRY_TO_EMAIL",
];

describe("payoutAttentionKey", () => {
  it("returns null when there is nothing actionable", async () => {
    const { payoutAttentionKey } = await load();
    assert.equal(payoutAttentionKey(base), null);
  });

  it("ignores informational cutover_skipped exceptions entirely", async () => {
    const { payoutAttentionKey } = await load();
    assert.equal(
      payoutAttentionKey({
        ...base,
        exceptions: [
          { code: "cutover_skipped", ref: "txn_1" },
          { code: "cutover_skipped", ref: "txn_2" },
        ],
      }),
      null
    );
  });

  it("is non-null for an actionable exception and stable across rebuilds", async () => {
    const { payoutAttentionKey } = await load();
    const input: PayoutAttentionInput = {
      ...base,
      exceptions: [{ code: "unmatched_movement", ref: "txn_r1" }],
    };
    const a = payoutAttentionKey(input);
    assert.ok(a);
    assert.equal(payoutAttentionKey({ ...input }), a);
  });

  it("excludes pending auto-apply work — the caller tracks it separately so retry resolution never re-sends", async () => {
    const { payoutAttentionKey } = await load();
    assert.equal(payoutAttentionKey({ ...base, autoPending: 1 }), null);
    // Pending state must not change the exception signature either —
    // a pending→resolved transition leaves the key identical.
    const withException: PayoutAttentionInput = {
      ...base,
      exceptions: [{ code: "unmatched_movement", ref: "txn_r1" }],
    };
    assert.equal(
      payoutAttentionKey({ ...withException, autoPending: 0 }),
      payoutAttentionKey({ ...withException, autoPending: 2 })
    );
  });

  it("changes when the exception set changes — resolved-then-new re-notifies", async () => {
    const { payoutAttentionKey } = await load();
    const first = payoutAttentionKey({
      ...base,
      exceptions: [{ code: "unmatched_movement", ref: "txn_r1" }],
    });
    const second = payoutAttentionKey({
      ...base,
      exceptions: [{ code: "foreign_currency", ref: "txn_f1" }],
    });
    assert.ok(first && second && first !== second);
    // Exception order must not affect the key.
    const reordered = payoutAttentionKey({
      ...base,
      exceptions: [
        { code: "foreign_currency", ref: "txn_f1" },
        { code: "unmatched_movement", ref: "txn_r1" },
      ],
    });
    const forward = payoutAttentionKey({
      ...base,
      exceptions: [
        { code: "unmatched_movement", ref: "txn_r1" },
        { code: "foreign_currency", ref: "txn_f1" },
      ],
    });
    assert.equal(reordered, forward);
  });
});

describe("getPayoutAttentionEmail", () => {
  it("prefers the dedicated variable, then staff notification fallbacks", async () => {
    const { getPayoutAttentionEmail } = await load();
    withEnv(
      Object.fromEntries(ATTENTION_ENV_KEYS.map((k) => [k, undefined])),
      () => {
        assert.equal(getPayoutAttentionEmail(), undefined);
      }
    );
    withEnv(
      { ...Object.fromEntries(ATTENTION_ENV_KEYS.map((k) => [k, undefined])), TRADE_INQUIRY_TO_EMAIL: "owner@example.com" },
      () => {
        assert.equal(getPayoutAttentionEmail(), "owner@example.com");
      }
    );
    withEnv(
      {
        TRADE_NOTIFICATION_EMAIL: "staff@example.com",
        TRADE_INQUIRY_TO_EMAIL: "legacy@example.com",
        PAYOUT_ATTENTION_EMAIL: "books@example.com",
      },
      () => {
        assert.equal(getPayoutAttentionEmail(), "books@example.com");
      }
    );
  });
});

describe("buildPayoutAttentionEmail", () => {
  it("carries payout identity, exceptions, applied state, and the admin link", async () => {
    const { buildPayoutAttentionEmail } = await load();
    const email = buildPayoutAttentionEmail(
      {
        ...base,
        exceptions: [
          {
            code: "unmatched_movement",
            ref: "txn_r1",
            detail: "Refund — review manually.",
            amountMinor: -3150,
          },
        ],
        autoApplied: 2,
      },
      "owner@example.com"
    );
    assert.equal(email.to, "owner@example.com");
    assert.match(email.subject, /po_test/);
    assert.match(email.subject, /190\.60 USD/);
    assert.match(email.text, /po_test/);
    assert.match(email.text, /unmatched_movement/);
    assert.match(email.text, /Refund — review manually\./);
    assert.match(email.text, /2 proposal\(s\) were already applied/);
    assert.match(email.text, /\/admin\/integrations\/quickbooks/);
    assert.match(email.text, /stay unposted until then/);
  });

  it("states plainly when nothing was applied", async () => {
    const { buildPayoutAttentionEmail } = await load();
    const email = buildPayoutAttentionEmail(
      { ...base, exceptions: [{ code: "ambiguous_match", ref: "txn_a" }] },
      "owner@example.com"
    );
    assert.match(email.text, /No accounting entries were applied/);
  });
});
