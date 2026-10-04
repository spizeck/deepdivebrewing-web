// Unit tests for lib/qbo-api.ts — the low-level Intuit provider boundary —
// focused on `intuit_tid` correlation capture: the header is read on every
// response so success paths can log it and failure/parse-error paths keep it
// on the normalized QboError.
import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { QboError } from "@/lib/qbo-errors";
import { installQboDbMock } from "./qbo-test-helpers";

installQboDbMock(); // registers the "server-only" stub

const TID = "1a2b3c4d-0000-4d00-8e00-000000000000";

function stubFetch(respond: (url: string) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) =>
    Promise.resolve(respond(String(input)))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// Captures the JSON lines logInfo writes so tests can assert on the
// structured context (correlation id, event name).
function captureInfoLogs() {
  const lines: Record<string, unknown>[] = [];
  const spy = mock.method(console, "info", (line: unknown) => {
    if (typeof line === "string") {
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        lines.push({ raw: line });
      }
    }
  });
  return {
    lines,
    restore: () => spy.mock.restore(),
  };
}

const INPUT = {
  environment: "sandbox" as const,
  realmId: "realm-1",
  accessToken: "at-1",
};

describe("intuit_tid capture", () => {
  it("logs the provider correlation id on a successful CompanyInfo call", async () => {
    const restoreFetch = stubFetch(() =>
      new Response(
        JSON.stringify({ CompanyInfo: { Id: "1", CompanyName: "Co" } }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            intuit_tid: TID,
          },
        }
      )
    );
    const logs = captureInfoLogs();
    try {
      const { fetchQboCompanyInfo } = await import("@/lib/qbo-api");
      const info = await fetchQboCompanyInfo(INPUT);
      assert.strictEqual(info.companyName, "Co");
      const line = logs.lines.find((l) => l.event === "qbo.api.companyinfo");
      assert.ok(line, "companyinfo log line missing");
      assert.strictEqual(line.correlationId, TID);
      assert.strictEqual(line.environment, "sandbox");
    } finally {
      logs.restore();
      restoreFetch();
    }
  });

  it("keeps the correlation id on a failed provider response", async () => {
    const restoreFetch = stubFetch(
      () =>
        new Response("provider exploded internally", {
          status: 500,
          headers: { intuit_tid: TID },
        })
    );
    try {
      const { fetchQboCompanyInfo } = await import("@/lib/qbo-api");
      await assert.rejects(fetchQboCompanyInfo(INPUT), (error: unknown) => {
        assert.ok(error instanceof QboError);
        assert.strictEqual(error.correlationId, TID);
        assert.strictEqual(error.kind, "unavailable");
        // The raw provider body never leaks into the surfaced error.
        assert.ok(!error.message.includes("exploded"));
        return true;
      });
    } finally {
      restoreFetch();
    }
  });

  it("preserves the correlation id when the body is malformed JSON", async () => {
    const restoreFetch = stubFetch(
      () =>
        new Response("<html>not json</html>", {
          status: 200,
          headers: { intuit_tid: TID },
        })
    );
    try {
      const { fetchQboCompanyInfo } = await import("@/lib/qbo-api");
      await assert.rejects(fetchQboCompanyInfo(INPUT), (error: unknown) => {
        assert.ok(error instanceof QboError);
        assert.strictEqual(error.correlationId, TID);
        assert.ok(!error.message.includes("<html>"));
        return true;
      });
    } finally {
      restoreFetch();
    }
  });

  it("tolerates a missing intuit_tid header", async () => {
    const restoreFetch = stubFetch(
      () =>
        new Response(
          JSON.stringify({ CompanyInfo: { CompanyName: "Co" } }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    );
    const logs = captureInfoLogs();
    try {
      const { fetchQboCompanyInfo } = await import("@/lib/qbo-api");
      const info = await fetchQboCompanyInfo(INPUT);
      assert.strictEqual(info.companyName, "Co");
      const line = logs.lines.find((l) => l.event === "qbo.api.companyinfo");
      assert.ok(line);
      assert.strictEqual(line.correlationId, undefined);
    } finally {
      logs.restore();
      restoreFetch();
    }
  });

  it("logs one correlation line per discovery run, not per page", async () => {
    let calls = 0;
    const restoreFetch = stubFetch(() => {
      calls++;
      // Two full pages then a partial page → three requests, one log line.
      const count = calls <= 2 ? 1000 : 3;
      const rows = Array.from({ length: count }, (_, i) => ({
        Id: `${calls}-${i}`,
        Name: `Item ${i}`,
      }));
      return new Response(
        JSON.stringify({ QueryResponse: { Item: rows } }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            intuit_tid: `tid-page-${calls}`,
          },
        }
      );
    });
    const logs = captureInfoLogs();
    try {
      const { queryQboEntities } = await import("@/lib/qbo-api");
      const entities = await queryQboEntities({ ...INPUT, type: "item" });
      assert.strictEqual(entities.length, 2003);
      const entityLogs = logs.lines.filter(
        (l) => l.event === "qbo.api.entities"
      );
      assert.strictEqual(entityLogs.length, 1);
      assert.strictEqual(entityLogs[0]?.correlationId, "tid-page-1");
      assert.strictEqual(entityLogs[0]?.pages, 3);
      assert.strictEqual(entityLogs[0]?.type, "item");
    } finally {
      logs.restore();
      restoreFetch();
    }
  });
});

describe("correlation id in error logs", () => {
  // QboError.correlationId reaching normalizeError is what puts the tid
  // into every logError/logWarn line (and monitoring) without per-call-site
  // plumbing.
  it("normalizeError surfaces a provider correlationId", async () => {
    const { normalizeError } = await import("@/lib/log");
    const normalized = normalizeError(
      new QboError("safe message", "unavailable", 502, TID)
    );
    assert.strictEqual(normalized.correlationId, TID);
    assert.strictEqual(normalizeError(new Error("x")).correlationId, undefined);
  });

  it("logError emits the correlation id in the structured line", async () => {
    const lines: Record<string, unknown>[] = [];
    const spy = mock.method(console, "error", (line: unknown) => {
      if (typeof line === "string") {
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* ignore */
        }
      }
    });
    try {
      const { logError } = await import("@/lib/log");
      logError(
        "qbo.test_event",
        new QboError("safe message", "unavailable", 502, TID)
      );
      const line = lines.find((l) => l.event === "qbo.test_event");
      assert.ok(line);
      assert.strictEqual(
        (line.error as Record<string, unknown>).correlationId,
        TID
      );
    } finally {
      spy.mock.restore();
    }
  });
});
