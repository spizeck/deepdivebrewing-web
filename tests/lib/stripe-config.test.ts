import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import {
  getStripeSecretKey,
  getStripeWebhookSecret,
  isStripeTestMode,
} from "@/lib/stripe-config";

const KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "VERCEL_ENV", "NODE_ENV"] as const;

function snapshot() {
  return Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
}

// NODE_ENV is typed read-only; assign via Object.assign (runtime mutable).
function setEnv(key: (typeof KEYS)[number], value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else Object.assign(process.env, { [key]: value });
}

function restore(saved: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(saved)) {
    setEnv(key as (typeof KEYS)[number], value);
  }
}

describe("stripe-config", () => {
  const saved = snapshot();
  afterEach(() => restore(saved));

  it("fails clearly when secrets are missing", () => {
    setEnv("STRIPE_SECRET_KEY", undefined);
    setEnv("STRIPE_WEBHOOK_SECRET", undefined);
    assert.throws(() => getStripeSecretKey(), /STRIPE_SECRET_KEY/);
    assert.throws(() => getStripeWebhookSecret(), /STRIPE_WEBHOOK_SECRET/);
  });

  it("accepts test keys anywhere and live keys only in production", () => {
    // Key strings are assembled, never literal — push protection must not
    // see anything shaped like a real credential in the repo.
    const testKey = "sk_" + "test_fixture";
    const liveKey = "sk_" + "live_fixture";
    const liveRestricted = "rk_" + "live_fixture";

    setEnv("STRIPE_SECRET_KEY", testKey);
    setEnv("NODE_ENV", "development");
    assert.strictEqual(getStripeSecretKey(), testKey);

    // Live key in local dev must fail closed.
    setEnv("STRIPE_SECRET_KEY", liveKey);
    assert.throws(() => getStripeSecretKey(), /not allowed outside production/);

    // ... and in Vercel preview deployments.
    setEnv("NODE_ENV", "production");
    setEnv("VERCEL_ENV", "preview");
    assert.throws(() => getStripeSecretKey(), /not allowed outside production/);
    setEnv("STRIPE_SECRET_KEY", liveRestricted);
    assert.throws(() => getStripeSecretKey(), /not allowed outside production/);

    // Production allows the live key.
    setEnv("VERCEL_ENV", undefined);
    setEnv("STRIPE_SECRET_KEY", liveKey);
    assert.strictEqual(getStripeSecretKey(), liveKey);
  });

  it("derives test mode from the key prefix", () => {
    assert.strictEqual(isStripeTestMode("sk_" + "test_x"), true);
    assert.strictEqual(isStripeTestMode("rk_" + "test_x"), true);
    assert.strictEqual(isStripeTestMode("sk_" + "live_x"), false);
  });
});
