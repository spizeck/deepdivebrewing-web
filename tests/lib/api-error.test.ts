import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { apiErrorResponse, isClientSafeError } from "@/lib/api-error";

class FakeSafeError extends Error {
  readonly clientSafe = true;
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

describe("isClientSafeError", () => {
  it("accepts errors explicitly marked client-safe with a status", () => {
    assert.ok(isClientSafeError(new FakeSafeError("nope", 403)));
  });

  it("rejects plain errors, status-only errors, and non-errors", () => {
    assert.ok(!isClientSafeError(new Error("internal detail")));
    assert.ok(
      !isClientSafeError(
        Object.assign(new Error("x"), { status: 500 }) // no clientSafe marker
      )
    );
    assert.ok(!isClientSafeError("nope"));
    assert.ok(!isClientSafeError(null));
  });
});

describe("apiErrorResponse", () => {
  it("returns the client-safe message and status without logging", async () => {
    const spy = mock.method(console, "error", () => {});
    try {
      const res = apiErrorResponse(new FakeSafeError("Requires admin.", 403), {
        fallback: "Failed.",
        event: "test.failed",
      });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { ok: false, error: "Requires admin." });
      assert.equal(spy.mock.calls.length, 0);
    } finally {
      spy.mock.restore();
    }
  });

  it("hides internal error details and logs the real error", async () => {
    const spy = mock.method(console, "error", () => {});
    try {
      const res = apiErrorResponse(
        new Error("firestore: 5 NOT_FOUND at secret/path"),
        {
          fallback: "Failed to update administrator.",
          event: "admin_users.update_failed",
          context: { requestId: "r1", targetUid: "u9" },
        }
      );
      assert.equal(res.status, 500);
      const body = await res.json();
      assert.deepEqual(body, {
        ok: false,
        error: "Failed to update administrator.",
      });
      assert.ok(!JSON.stringify(body).includes("secret/path"));

      // The real error is preserved in the structured server log.
      assert.equal(spy.mock.calls.length, 1);
      const line = JSON.parse(String(spy.mock.calls[0].arguments[0]));
      assert.equal(line.event, "admin_users.update_failed");
      assert.equal(line.error.message, "firestore: 5 NOT_FOUND at secret/path");
      assert.equal(line.requestId, "r1");
      assert.equal(line.targetUid, "u9");
    } finally {
      spy.mock.restore();
    }
  });
});
