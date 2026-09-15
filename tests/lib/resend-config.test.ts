import { describe, it } from "node:test";
import assert from "node:assert";
import { getResendApiKey } from "@/lib/resend-config";

const KEY = "RESEND_API_KEY";

function withKey(value: string | undefined, fn: () => void) {
  const original = process.env[KEY];
  if (value === undefined) {
    delete process.env[KEY];
  } else {
    process.env[KEY] = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = original;
    }
  }
}

describe("getResendApiKey", () => {
  it("throws a clear error naming the missing variable", () => {
    withKey(undefined, () => {
      assert.throws(
        () => getResendApiKey(),
        (err: Error) =>
          err.message ===
          "Resend API key is not configured (RESEND_API_KEY)."
      );
    });
  });

  it("error message never contains a secret value", () => {
    withKey(undefined, () => {
      try {
        getResendApiKey();
        assert.fail("expected getResendApiKey to throw");
      } catch (err) {
        const message = (err as Error).message;
        assert.ok(!message.startsWith("re_"));
        assert.ok(!/re_[A-Za-z0-9]/.test(message));
      }
    });
  });

  it("returns the configured key", () => {
    withKey("re_test_key_123", () => {
      assert.equal(getResendApiKey(), "re_test_key_123");
    });
  });
});
