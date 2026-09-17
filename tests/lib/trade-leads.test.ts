import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildTradeLeadRecord,
  processTradeInquiry,
  tradeLeadFieldTooLong,
  TRADE_LEAD_FIELD_LIMITS,
  TRADE_LEADS_COLLECTION,
  type TradeInquiryDeps,
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
