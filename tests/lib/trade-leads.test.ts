import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTradeLeadRecord,
  handleTradeInquiry,
  processTradeInquiry,
  tradeLeadFieldTooLong,
  TRADE_LEAD_FIELD_LIMITS,
  TRADE_LEADS_COLLECTION,
  type TradeInquiryDeps,
  type TradeInquiryRouteDeps,
  type TradeInquiryBody,
  type TradeLeadInput,
} from "@/lib/trade-leads-common";
import type { LogContext } from "@/lib/log";

const input: TradeLeadInput = {
  businessName: "Test Venue",
  contactName: "Test Contact",
  email: "venue@example.com",
  phoneOrWhatsapp: "+599 000 0000",
  venueType: "bar",
  message: "We would like to carry your beer.",
};

interface CapturedLog {
  level: "info" | "error";
  event: string;
  context?: LogContext;
  error?: unknown;
}

function makeDeps(overrides: {
  persist?: TradeInquiryDeps["persist"];
  notify?: TradeInquiryDeps["notify"];
} = {}): { deps: TradeInquiryDeps; logs: CapturedLog[]; calls: string[] } {
  const logs: CapturedLog[] = [];
  const calls: string[] = [];
  const deps: TradeInquiryDeps = {
    persist:
      overrides.persist ??
      (async () => {
        calls.push("persist");
        return "lead-123";
      }),
    notify:
      overrides.notify ??
      (async () => {
        calls.push("notify");
      }),
    logInfo: (event, context) => logs.push({ level: "info", event, context }),
    logError: (event, error, context) =>
      logs.push({ level: "error", event, context, error }),
  };
  return { deps, logs, calls };
}

describe("buildTradeLeadRecord", () => {
  it("persists exactly the inquiry fields with status new and trade_form source", () => {
    const record = buildTradeLeadRecord(input);
    assert.deepStrictEqual(record, {
      businessName: "Test Venue",
      contactName: "Test Contact",
      email: "venue@example.com",
      phoneOrWhatsapp: "+599 000 0000",
      venueType: "bar",
      message: "We would like to carry your beer.",
      status: "new",
      source: "trade_form",
    });
  });

  it("targets the tradeLeads collection", () => {
    assert.strictEqual(TRADE_LEADS_COLLECTION, "tradeLeads");
  });
});

describe("tradeLeadFieldTooLong", () => {
  it("accepts inputs within the field limits", () => {
    assert.strictEqual(tradeLeadFieldTooLong(input), null);
  });

  it("rejects a field that exceeds its limit", () => {
    const tooLong = {
      ...input,
      message: "x".repeat(TRADE_LEAD_FIELD_LIMITS.message + 1),
    };
    assert.strictEqual(tradeLeadFieldTooLong(tooLong), "message");
  });

  it("accepts a field at exactly its limit", () => {
    const atLimit = {
      ...input,
      businessName: "x".repeat(TRADE_LEAD_FIELD_LIMITS.businessName),
    };
    assert.strictEqual(tradeLeadFieldTooLong(atLimit), null);
  });
});

describe("processTradeInquiry", () => {
  it("persists before notifying and returns the lead id", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await processTradeInquiry(input, "req-1", deps);
    assert.deepStrictEqual(outcome, { ok: true, leadId: "lead-123" });
    assert.deepStrictEqual(calls, ["persist", "notify"]);
  });

  it("passes the lead id to the notifier for operator correlation", async () => {
    let seenLeadId: string | undefined;
    const { deps } = makeDeps({
      notify: async (_input, leadId) => {
        seenLeadId = leadId;
      },
    });
    await processTradeInquiry(input, "req-1", deps);
    assert.strictEqual(seenLeadId, "lead-123");
  });

  it("still succeeds when the notification fails after persistence", async () => {
    const { deps, logs } = makeDeps({
      notify: async () => {
        throw new Error("Resend down");
      },
    });
    const outcome = await processTradeInquiry(input, "req-1", deps);
    assert.deepStrictEqual(outcome, { ok: true, leadId: "lead-123" });
    assert.deepStrictEqual(
      logs.map((l) => l.event),
      [
        "trade_inquiry.persisted",
        "trade_inquiry.notification_failed",
      ]
    );
  });

  it("logs notification_sent when the email succeeds", async () => {
    const { deps, logs } = makeDeps();
    await processTradeInquiry(input, "req-1", deps);
    assert.deepStrictEqual(
      logs.map((l) => l.event),
      ["trade_inquiry.persisted", "trade_inquiry.notification_sent"]
    );
  });

  it("returns a classified failure (already logged) when persistence fails", async () => {
    const { deps, logs, calls } = makeDeps({
      persist: async () => {
        calls.push("persist");
        throw new Error("Firestore unavailable");
      },
    });
    const outcome = await processTradeInquiry(input, "req-1", deps);
    assert.deepStrictEqual(outcome, { ok: false });
    // Notification is never attempted without a durable record.
    assert.deepStrictEqual(calls, ["persist"]);
    assert.deepStrictEqual(
      logs.map((l) => l.event),
      ["trade_inquiry.persistence_failed"]
    );
  });

  it("never logs submitted PII — only leadId, requestId, and venueType", async () => {
    const { deps, logs } = makeDeps({
      notify: async () => {
        throw new Error("provider error");
      },
    });
    await processTradeInquiry(input, "req-1", deps);
    const serialized = JSON.stringify(logs);
    for (const pii of [
      input.businessName,
      input.contactName,
      input.email,
      input.phoneOrWhatsapp,
      input.message,
    ]) {
      assert.ok(!serialized.includes(pii), `log leaked ${pii}`);
    }
  });
});

// The POST /api/trade-inquiry pipeline (Issue #117). `submit` is the single
// entry point to persistence + notification (submitTradeInquiry →
// processTradeInquiry → persist + notify), so "submit never called" proves a
// rejected request neither writes a tradeLeads record nor attempts a Resend
// send.
describe("handleTradeInquiry", () => {
  const body: TradeInquiryBody = {
    businessName: "Test Venue",
    contactName: "Test Contact",
    email: "venue@example.com",
    phoneOrWhatsapp: "+599 000 0000",
    venueType: "bar",
    message: "We would like to carry your beer.",
  };

  function routeDeps(overrides: {
    isRateLimited?: TradeInquiryRouteDeps["isRateLimited"];
    submit?: TradeInquiryRouteDeps["submit"];
  } = {}) {
    const calls: string[] = [];
    const submitted: TradeLeadInput[] = [];
    const deps: TradeInquiryRouteDeps = {
      isRateLimited:
        overrides.isRateLimited ??
        (() => {
          calls.push("isRateLimited");
          return false;
        }),
      submit:
        overrides.submit ??
        (async (submittedInput) => {
          calls.push("submit");
          submitted.push(submittedInput);
          return { ok: true, leadId: "lead-123" };
        }),
    };
    return { deps, calls, submitted };
  }

  const context = { clientIp: "203.0.113.10", requestId: "req-1" };

  it("rejects malformed email addresses before persistence or notification", async () => {
    for (const email of [
      "not-an-email",
      "customer@",
      "@example.com",
      "customer@example",
      "custom er@example.com",
      "customer@@example.com",
      "customer@example@com",
    ]) {
      const { deps, calls } = routeDeps();
      const result = await handleTradeInquiry({ ...body, email }, context, deps);
      assert.strictEqual(result.status, 400, `expected 400 for ${email}`);
      assert.deepStrictEqual(result.body, {
        ok: false,
        error: "Please enter a valid email address.",
      });
      assert.deepStrictEqual(calls, [], `submit/rate-limit ran for ${email}`);
    }
  });

  it("trims surrounding whitespace before validating the email", async () => {
    const { deps, submitted } = routeDeps();
    const result = await handleTradeInquiry(
      { ...body, email: "  venue@example.com  " },
      context,
      deps
    );
    assert.strictEqual(result.status, 200);
    assert.strictEqual(submitted[0]?.email, "venue@example.com");
  });

  it("rejects a whitespace-only email as missing", async () => {
    const { deps, calls } = routeDeps();
    const result = await handleTradeInquiry(
      { ...body, email: "   " },
      context,
      deps
    );
    assert.strictEqual(result.status, 400);
    assert.match(result.body.error ?? "", /required fields/);
    assert.deepStrictEqual(calls, []);
  });

  it("still rejects a missing email as a required-field error", async () => {
    const { deps, calls } = routeDeps();
    const result = await handleTradeInquiry(
      { ...body, email: undefined },
      context,
      deps
    );
    assert.strictEqual(result.status, 400);
    assert.match(result.body.error ?? "", /required fields/);
    assert.deepStrictEqual(calls, []);
  });

  it("still rejects an oversized email as a length error", async () => {
    const { deps, calls } = routeDeps();
    const result = await handleTradeInquiry(
      { ...body, email: `${"a".repeat(TRADE_LEAD_FIELD_LIMITS.email)}@example.com` },
      context,
      deps
    );
    assert.strictEqual(result.status, 400);
    // The customer-facing message names the field by its form label, never
    // the camelCase API key.
    assert.strictEqual(
      result.body.error,
      "Please shorten the email field."
    );
    assert.deepStrictEqual(calls, []);
  });

  it("accepts ordinary, plus-tag, and subdomain addresses", async () => {
    for (const email of [
      "customer@example.com",
      "first.last@example.com",
      "customer+trade@example.com",
      "sales@wholesale.example.com",
    ]) {
      const { deps, submitted } = routeDeps();
      const result = await handleTradeInquiry({ ...body, email }, context, deps);
      assert.strictEqual(result.status, 200, `expected 200 for ${email}`);
      assert.deepStrictEqual(result.body, { ok: true });
      assert.strictEqual(submitted[0]?.email, email);
    }
  });

  it("keeps the honeypot short-circuit ahead of the rate limiter and submit", async () => {
    const { deps, calls } = routeDeps();
    const result = await handleTradeInquiry(
      { ...body, website: "https://spam.example" },
      context,
      deps
    );
    assert.deepStrictEqual(result, { status: 200, body: { ok: true } });
    assert.deepStrictEqual(calls, []);
  });

  it("returns 429 and does not submit when rate limited", async () => {
    const { deps, calls } = routeDeps({
      isRateLimited: () => {
        calls.push("isRateLimited");
        return true;
      },
    });
    const result = await handleTradeInquiry(body, context, deps);
    assert.strictEqual(result.status, 429);
    assert.match(result.body.error ?? "", /Too many requests/);
    assert.deepStrictEqual(calls, ["isRateLimited"]);
  });

  it("maps a failed submission to a generic 500", async () => {
    const { deps } = routeDeps({
      submit: async () => ({ ok: false }),
    });
    const result = await handleTradeInquiry(body, context, deps);
    assert.deepStrictEqual(result, {
      status: 500,
      body: {
        ok: false,
        error: "Something went wrong on our end. Please try again.",
      },
    });
  });

  it("submits exactly the trimmed lead fields with the request id", async () => {
    const { deps, submitted } = routeDeps();
    await handleTradeInquiry(
      { ...body, businessName: "  Test Venue  ", website: "" },
      { clientIp: "198.51.100.7", requestId: "req-9" },
      deps
    );
    assert.deepStrictEqual(submitted, [
      {
        businessName: "Test Venue",
        contactName: "Test Contact",
        email: "venue@example.com",
        phoneOrWhatsapp: "+599 000 0000",
        venueType: "bar",
        message: "We would like to carry your beer.",
      },
    ]);
  });
});

// The route module cannot be imported here (it pulls in server-only
// modules), so the wiring between POST and the tested pipeline is asserted
// on the source — the same pattern as tests/lib/admin-session-refresh.test.ts.
describe("trade-inquiry route wiring", () => {
  const route = readFileSync(
    join(process.cwd(), "app/api/trade-inquiry/route.ts"),
    "utf8"
  );

  it("delegates to handleTradeInquiry with the real submitter and rate limiter", () => {
    assert.ok(route.includes("handleTradeInquiry("));
    assert.ok(route.includes("submit: submitTradeInquiry"));
    assert.ok(route.includes("isRateLimited"));
  });

  it("returns the pipeline result verbatim as the JSON response", () => {
    assert.ok(
      route.includes("NextResponse.json(result.body, { status: result.status })")
    );
  });
});
