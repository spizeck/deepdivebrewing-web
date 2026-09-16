import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { getRequestId, logError, logInfo, logWarn } from "@/lib/log";

function captureConsole(method: "info" | "warn" | "error") {
  const calls: string[] = [];
  const restore = mock.method(console, method, (msg: string) => {
    calls.push(String(msg));
  });
  return { calls, restore: () => restore.mock.restore() };
}

describe("structured logging", () => {
  it("emits single-line JSON with level and stable event name", () => {
    const { calls, restore } = captureConsole("info");
    try {
      logInfo("admin_rebuild.triggered", { uid: "u1", role: "admin" });
    } finally {
      restore();
    }
    assert.equal(calls.length, 1);
    const line = JSON.parse(calls[0]);
    assert.equal(line.level, "info");
    assert.equal(line.event, "admin_rebuild.triggered");
    assert.equal(line.uid, "u1");
    assert.equal(line.role, "admin");
  });

  it("drops sensitive-looking context keys but keeps safe ones", () => {
    const { calls, restore } = captureConsole("error");
    try {
      logError("test.event", undefined, {
        requestId: "r1",
        authorization: "Bearer secret-token",
        apiKey: "secret",
        deployHookUrl: "https://hooks.example/secret",
        uid: "u2",
      });
    } finally {
      restore();
    }
    const line = JSON.parse(calls[0]);
    assert.equal(line.requestId, "r1");
    assert.equal(line.uid, "u2");
    for (const key of Object.keys(line)) {
      assert.ok(
        !/authorization|api[-_]?key|deploy[-_]?hook/i.test(key),
        `sensitive key leaked: ${key}`
      );
    }
    assert.ok(!calls[0].includes("secret-token"));
  });

  it("normalizes non-Error values instead of dumping objects", () => {
    const { calls, restore } = captureConsole("error");
    try {
      logError("test.event", "plain string failure");
      logError("test.event2", { weird: { nested: true } });
    } finally {
      restore();
    }
    const first = JSON.parse(calls[0]);
    assert.equal(first.error.name, "UnknownError");
    assert.equal(first.error.message, "plain string failure");
    const second = JSON.parse(calls[1]);
    assert.equal(second.error.name, "UnknownError");
    assert.equal(typeof second.error.message, "string");
  });

  it("normalizes Error instances with name, message, and code", () => {
    const { calls, restore } = captureConsole("error");
    try {
      const err = new Error("boom") as Error & { code?: string };
      err.code = "auth/invalid-api-key";
      logError("test.event", err, { requestId: "r9" });
    } finally {
      restore();
    }
    const line = JSON.parse(calls[0]);
    assert.equal(line.error.name, "Error");
    assert.equal(line.error.message, "boom");
    assert.equal(line.error.code, "auth/invalid-api-key");
    assert.equal(line.requestId, "r9");
  });

  it("normalizes provider error objects (name/message/statusCode)", () => {
    const { calls, restore } = captureConsole("error");
    try {
      // Resend-style error: a plain object, not an Error instance.
      logError("test.event", { name: "invalid_api_key", message: "bad key", statusCode: 403 });
    } finally {
      restore();
    }
    const line = JSON.parse(calls[0]);
    assert.equal(line.error.name, "invalid_api_key");
    assert.equal(line.error.message, "bad key");
    assert.equal(line.error.code, "403");
  });

  it("caps overlong string context values", () => {
    const { calls, restore } = captureConsole("warn");
    try {
      logWarn("test.event", { note: "x".repeat(1000) });
    } finally {
      restore();
    }
    const line = JSON.parse(calls[0]);
    assert.ok(line.note.length <= 301);
  });

  it("omits undefined context values", () => {
    const { calls, restore } = captureConsole("warn");
    try {
      logWarn("test.event", { a: "keep", b: undefined });
    } finally {
      restore();
    }
    const line = JSON.parse(calls[0]);
    assert.equal(line.a, "keep");
    assert.ok(!("b" in line));
  });
});

describe("getRequestId", () => {
  it("prefers the Vercel request id", () => {
    const headers = new Headers({ "x-vercel-id": "vcd::abc123" });
    assert.equal(getRequestId(headers), "vcd::abc123");
  });

  it("falls back to x-request-id", () => {
    const headers = new Headers({ "x-request-id": "req-42" });
    assert.equal(getRequestId(headers), "req-42");
  });

  it("generates a uuid when no header is present", () => {
    const id = getRequestId(new Headers());
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });
});
