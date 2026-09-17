import { describe, it } from "node:test";
import assert from "node:assert";
import {
  tradeLeadRetentionCutoff,
  tradeLeadRetentionStatus,
  TRADE_LEAD_RETENTION_MONTHS,
} from "@/lib/trade-leads-common";

const NOW = new Date("2026-09-17T12:00:00.000Z");
const CUTOFF = tradeLeadRetentionCutoff(NOW);

// Minimal stand-ins for firebase-admin Timestamp shapes.
const ts = (iso: string) => ({ toMillis: () => new Date(iso).getTime() });
const legacyTs = (iso: string) => ({ seconds: new Date(iso).getTime() / 1000 });

describe("tradeLeadRetentionCutoff", () => {
  it("is exactly 24 months before now", () => {
    assert.strictEqual(TRADE_LEAD_RETENTION_MONTHS, 24);
    assert.strictEqual(CUTOFF.toISOString(), "2024-09-17T12:00:00.000Z");
  });

  it("clamps the Feb 29 leap-day edge to Feb 28 instead of overflowing", () => {
    const cutoff = tradeLeadRetentionCutoff(new Date("2024-02-29T12:00:00.000Z"));
    assert.strictEqual(cutoff.toISOString(), "2022-02-28T12:00:00.000Z");
  });
});

describe("tradeLeadRetentionStatus", () => {
  it("expires a lead whose anchor is at or before the cutoff", () => {
    assert.strictEqual(
      tradeLeadRetentionStatus({ updatedAt: ts("2024-09-17T12:00:00.000Z") }, CUTOFF),
      "expired"
    );
    assert.strictEqual(
      tradeLeadRetentionStatus({ updatedAt: ts("2024-09-17T11:59:59.000Z") }, CUTOFF),
      "expired"
    );
  });

  it("retains a lead whose anchor is after the cutoff", () => {
    assert.strictEqual(
      tradeLeadRetentionStatus({ updatedAt: ts("2024-09-17T12:00:01.000Z") }, CUTOFF),
      "retained"
    );
    assert.strictEqual(
      tradeLeadRetentionStatus({ updatedAt: ts("2026-09-17T12:00:00.000Z") }, CUTOFF),
      "retained"
    );
  });

  it("prefers updatedAt over createdAt as the retention anchor", () => {
    // Old submission but recent activity → retained.
    assert.strictEqual(
      tradeLeadRetentionStatus(
        { createdAt: ts("2024-01-01T00:00:00.000Z"), updatedAt: ts("2026-09-01T00:00:00.000Z") },
        CUTOFF
      ),
      "retained"
    );
    // Recent creation but an old updatedAt still expires (documented anchor).
    assert.strictEqual(
      tradeLeadRetentionStatus(
        { createdAt: ts("2026-09-01T00:00:00.000Z"), updatedAt: ts("2024-01-01T00:00:00.000Z") },
        CUTOFF
      ),
      "expired"
    );
  });

  it("falls back to createdAt when updatedAt is absent", () => {
    assert.strictEqual(
      tradeLeadRetentionStatus({ createdAt: ts("2024-01-01T00:00:00.000Z") }, CUTOFF),
      "expired"
    );
  });

  it("accepts Date and { seconds } timestamp shapes", () => {
    assert.strictEqual(
      tradeLeadRetentionStatus({ updatedAt: new Date("2024-01-01") }, CUTOFF),
      "expired"
    );
    assert.strictEqual(
      tradeLeadRetentionStatus({ updatedAt: legacyTs("2026-09-01T00:00:00.000Z") }, CUTOFF),
      "retained"
    );
  });

  it("reports unknown for missing or malformed timestamps so they are never deleted", () => {
    assert.strictEqual(tradeLeadRetentionStatus({}, CUTOFF), "unknown");
    assert.strictEqual(
      tradeLeadRetentionStatus({ updatedAt: null, createdAt: null }, CUTOFF),
      "unknown"
    );
    assert.strictEqual(
      tradeLeadRetentionStatus({ updatedAt: "not a timestamp" }, CUTOFF),
      "unknown"
    );
    assert.strictEqual(
      tradeLeadRetentionStatus({ updatedAt: new Date("garbage") }, CUTOFF),
      "unknown"
    );
  });
});
