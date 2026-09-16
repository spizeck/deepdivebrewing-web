import { describe, it } from "node:test";
import assert from "node:assert";
import {
  DEFAULT_RESEND_FROM_EMAIL,
  getAdminInviteFromEmail,
  getDefaultFromEmail,
  getResendApiKey,
} from "@/lib/resend-config";

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

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void
) {
  const originals = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    originals.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [name, original] of originals) {
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
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

describe("getDefaultFromEmail", () => {
  it("returns the shared default on the verified sending domain", () => {
    withEnv({ RESEND_FROM_EMAIL: undefined }, () => {
      assert.equal(getDefaultFromEmail(), DEFAULT_RESEND_FROM_EMAIL);
      assert.ok(DEFAULT_RESEND_FROM_EMAIL.includes("@mail.deepdivebrewing.com"));
    });
  });

  it("prefers RESEND_FROM_EMAIL when set", () => {
    withEnv(
      { RESEND_FROM_EMAIL: "Brewery <trade@mail.deepdivebrewing.com>" },
      () => {
        assert.equal(
          getDefaultFromEmail(),
          "Brewery <trade@mail.deepdivebrewing.com>"
        );
      }
    );
  });

  it("treats a blank RESEND_FROM_EMAIL as unset", () => {
    withEnv({ RESEND_FROM_EMAIL: "   " }, () => {
      assert.equal(getDefaultFromEmail(), DEFAULT_RESEND_FROM_EMAIL);
    });
  });
});

describe("getAdminInviteFromEmail", () => {
  it("prefers ADMIN_INVITE_FROM_EMAIL over the shared sender", () => {
    withEnv(
      {
        ADMIN_INVITE_FROM_EMAIL: "invites@mail.deepdivebrewing.com",
        RESEND_FROM_EMAIL: "trade@mail.deepdivebrewing.com",
      },
      () => {
        assert.equal(
          getAdminInviteFromEmail(),
          "invites@mail.deepdivebrewing.com"
        );
      }
    );
  });

  it("falls back to RESEND_FROM_EMAIL, then the shared default", () => {
    withEnv(
      {
        ADMIN_INVITE_FROM_EMAIL: undefined,
        RESEND_FROM_EMAIL: "trade@mail.deepdivebrewing.com",
      },
      () => {
        assert.equal(
          getAdminInviteFromEmail(),
          "trade@mail.deepdivebrewing.com"
        );
      }
    );
    withEnv(
      { ADMIN_INVITE_FROM_EMAIL: undefined, RESEND_FROM_EMAIL: undefined },
      () => {
        assert.equal(getAdminInviteFromEmail(), DEFAULT_RESEND_FROM_EMAIL);
      }
    );
  });
});
