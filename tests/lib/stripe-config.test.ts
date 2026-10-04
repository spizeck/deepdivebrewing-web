import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import {
  getStripeSecretKey,
  getStripeWebhookSecret,
  isStripeTestMode,
  resolveCheckoutReturnBaseUrl,
} from "@/lib/stripe-config";
import { siteUrl } from "@/lib/site";

const KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_BRANCH_URL",
  "NODE_ENV",
  "NEXT_PUBLIC_SITE_URL",
] as const;

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

describe("resolveCheckoutReturnBaseUrl", () => {
  const saved = snapshot();
  afterEach(() => restore(saved));

  it("production always returns the canonical site origin", () => {
    setEnv("VERCEL_ENV", "production");
    setEnv("NODE_ENV", "production");
    setEnv("VERCEL_URL", "ddb-abc123.vercel.app");
    setEnv("VERCEL_BRANCH_URL", "ddb-branch.vercel.app");
    setEnv("NEXT_PUBLIC_SITE_URL", undefined);
    // `siteUrl` is resolved once at module load, so assert the contract
    // (production returns the canonical site origin), not a recomputation
    // of the env var the module already froze.
    assert.strictEqual(resolveCheckoutReturnBaseUrl(), siteUrl);
    assert.ok(siteUrl.startsWith("https://"));
  });

  it("preview deployments return to their own host, branch alias preferred", () => {
    setEnv("VERCEL_ENV", "preview");
    setEnv("NODE_ENV", "production");
    setEnv("VERCEL_URL", "ddb-abc123.vercel.app");
    setEnv(
      "VERCEL_BRANCH_URL",
      "deepdivebrewing-web-git-feat-155-x.vercel.app"
    );
    assert.strictEqual(
      resolveCheckoutReturnBaseUrl(),
      "https://deepdivebrewing-web-git-feat-155-x.vercel.app"
    );

    // Falls back to the per-deployment host when no branch alias exists.
    setEnv("VERCEL_BRANCH_URL", undefined);
    assert.strictEqual(
      resolveCheckoutReturnBaseUrl(),
      "https://ddb-abc123.vercel.app"
    );
  });

  it("preview return URLs are always https and never user-supplied", () => {
    setEnv("VERCEL_ENV", "preview");
    setEnv("VERCEL_BRANCH_URL", "evil.example.com");
    // The host itself comes from Vercel-provided env (trusted deployment
    // config, not request input) and always gets the https scheme.
    const url = resolveCheckoutReturnBaseUrl();
    assert.ok(url.startsWith("https://"));
    assert.ok(!url.startsWith("http://"));
  });

  it("local dev defaults to the dev server origin", () => {
    setEnv("VERCEL_ENV", undefined);
    setEnv("NODE_ENV", "development");
    setEnv("NEXT_PUBLIC_SITE_URL", undefined);
    assert.strictEqual(
      resolveCheckoutReturnBaseUrl(),
      "http://localhost:3000"
    );
  });

  it("local dev honors a deliberately configured https site URL (e.g. a tunnel)", () => {
    setEnv("VERCEL_ENV", undefined);
    setEnv("NODE_ENV", "development");
    setEnv("NEXT_PUBLIC_SITE_URL", "https://ddb-tunnel.example.com");
    assert.strictEqual(
      resolveCheckoutReturnBaseUrl(),
      "https://ddb-tunnel.example.com"
    );
  });

  it("a non-localhost http override is ignored in dev", () => {
    setEnv("VERCEL_ENV", undefined);
    setEnv("NODE_ENV", "development");
    setEnv("NEXT_PUBLIC_SITE_URL", "http://insecure.example.com");
    assert.strictEqual(
      resolveCheckoutReturnBaseUrl(),
      "http://localhost:3000"
    );
  });
});
