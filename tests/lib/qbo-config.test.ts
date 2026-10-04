import { describe, it } from "node:test";
import assert from "node:assert";
import {
  getQboEnvironment,
  getQboWebhookVerifierToken,
  isQboConfigured,
  loadQboConfig,
  qboApiBaseUrl,
  QBO_ACCOUNTING_SCOPE,
  QBO_MINOR_VERSION,
} from "@/lib/qbo-config";
import { QboConfigError } from "@/lib/qbo-errors";

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

const FULL_ENV = {
  QBO_ENVIRONMENT: "sandbox",
  QBO_CLIENT_ID: "client-id",
  QBO_CLIENT_SECRET: "client-secret",
  QBO_REDIRECT_URI: "https://app.example.com/api/admin/quickbooks/callback",
  QBO_WEBHOOK_VERIFIER_TOKEN: "verifier",
  QBO_TOKEN_ENCRYPTION_KEY: "0".repeat(64),
};

describe("getQboEnvironment", () => {
  it("parses sandbox and production", () => {
    assert.strictEqual(getQboEnvironment("sandbox"), "sandbox");
    assert.strictEqual(getQboEnvironment("production"), "production");
    assert.strictEqual(getQboEnvironment(" Sandbox "), "sandbox");
  });

  it("fails closed on a missing value", () => {
    assert.throws(() => getQboEnvironment(undefined), QboConfigError);
    assert.throws(() => getQboEnvironment(""), QboConfigError);
  });

  it("fails closed on an unknown value", () => {
    assert.throws(() => getQboEnvironment("staging"), QboConfigError);
    assert.throws(() => getQboEnvironment("dev"), QboConfigError);
  });
});

describe("qboApiBaseUrl", () => {
  it("uses the Intuit sandbox host for sandbox", () => {
    assert.strictEqual(
      qboApiBaseUrl("sandbox"),
      "https://sandbox-quickbooks.api.intuit.com"
    );
  });

  it("uses the Intuit production host for production", () => {
    assert.strictEqual(
      qboApiBaseUrl("production"),
      "https://quickbooks.api.intuit.com"
    );
  });
});

describe("loadQboConfig", () => {
  it("returns the full config when all variables are set", () => {
    withEnv(FULL_ENV, () => {
      const config = loadQboConfig();
      assert.strictEqual(config.environment, "sandbox");
      assert.strictEqual(config.clientId, "client-id");
      assert.strictEqual(config.clientSecret, "client-secret");
      assert.strictEqual(config.redirectUri, FULL_ENV.QBO_REDIRECT_URI);
    });
  });

  it("throws a config error naming each missing variable", () => {
    for (const key of ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_REDIRECT_URI", "QBO_ENVIRONMENT"]) {
      withEnv({ ...FULL_ENV, [key]: undefined }, () => {
        assert.throws(() => loadQboConfig(), QboConfigError, key);
      });
    }
  });

  it("rejects a non-URL redirect URI", () => {
    withEnv({ ...FULL_ENV, QBO_REDIRECT_URI: "not-a-url" }, () => {
      assert.throws(() => loadQboConfig(), QboConfigError);
    });
  });

  it("rejects a non-https redirect URI outside localhost", () => {
    withEnv(
      { ...FULL_ENV, QBO_REDIRECT_URI: "http://app.example.com/cb" },
      () => {
        assert.throws(() => loadQboConfig(), QboConfigError);
      }
    );
  });

  it("allows http redirect URIs on localhost for development", () => {
    withEnv(
      { ...FULL_ENV, QBO_REDIRECT_URI: "http://localhost:3000/api/admin/quickbooks/callback" },
      () => {
        const config = loadQboConfig();
        assert.ok(config.redirectUri.startsWith("http://localhost"));
      }
    );
  });
});

describe("isQboConfigured", () => {
  it("is true only when environment plus credentials are all present", () => {
    withEnv(FULL_ENV, () => {
      assert.strictEqual(isQboConfigured(), true);
    });
    withEnv({ ...FULL_ENV, QBO_CLIENT_SECRET: undefined }, () => {
      assert.strictEqual(isQboConfigured(), false);
    });
    withEnv({ ...FULL_ENV, QBO_ENVIRONMENT: "bogus" }, () => {
      assert.strictEqual(isQboConfigured(), false);
    });
    withEnv({ ...FULL_ENV, QBO_ENVIRONMENT: undefined }, () => {
      assert.strictEqual(isQboConfigured(), false);
    });
    // The token-encryption key is part of "configured" — without it the
    // OAuth callback would only fail after consent completed.
    withEnv({ ...FULL_ENV, QBO_TOKEN_ENCRYPTION_KEY: undefined }, () => {
      assert.strictEqual(isQboConfigured(), false);
    });
    withEnv({ ...FULL_ENV, QBO_TOKEN_ENCRYPTION_KEY: "short" }, () => {
      assert.strictEqual(isQboConfigured(), false);
    });
  });
});

describe("getQboWebhookVerifierToken", () => {
  it("returns the token or undefined", () => {
    withEnv(FULL_ENV, () => {
      assert.strictEqual(getQboWebhookVerifierToken(), "verifier");
    });
    withEnv({ ...FULL_ENV, QBO_WEBHOOK_VERIFIER_TOKEN: undefined }, () => {
      assert.strictEqual(getQboWebhookVerifierToken(), undefined);
    });
  });
});

describe("constants", () => {
  it("requests the accounting scope and a supported minor version", () => {
    assert.strictEqual(
      QBO_ACCOUNTING_SCOPE,
      "com.intuit.quickbooks.accounting"
    );
    // Intuit deprecated minor versions below 75 on 2025-08-01.
    assert.ok(Number(QBO_MINOR_VERSION) >= 75);
  });
});
