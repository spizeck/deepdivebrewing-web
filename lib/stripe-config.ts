// Stripe environment configuration. Pure env reads — no SDK import — so
// config validation stays unit-testable and free of the server-only
// dependency chain. Only server modules (lib/stripe.ts, the payments API
// routes, the webhook route) import these; the secret key must never reach
// a client component or a NEXT_PUBLIC_* variable.

const LIVE_KEY_PREFIXES = ["sk_live_", "rk_live_"];

export function getStripeSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw new Error(
      "Missing Stripe credentials. Set STRIPE_SECRET_KEY (server-only)."
    );
  }
  // Live keys belong to production only — preview deployments and local
  // dev must run on test keys so a staging payment can never move real
  // money. `next build` never evaluates this (the client is lazy), so the
  // check cannot break a production build.
  const nonProduction =
    process.env.VERCEL_ENV === "preview" ||
    process.env.NODE_ENV === "development";
  if (nonProduction && LIVE_KEY_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error(
      "Live Stripe keys are not allowed outside production. Configure a test key (sk_test_*) for this environment."
    );
  }
  return key;
}

// Webhook signing secret is required at the verification boundary — the
// route refuses to run without it rather than accepting unsigned events.
export function getStripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error(
      "Missing Stripe webhook secret. Set STRIPE_WEBHOOK_SECRET (server-only)."
    );
  }
  return secret;
}

// Test/live mode is derived from the configured secret key so the admin UI
// can badge "test mode" without any key material leaving the server. Live
// Stripe objects also carry `livemode` — the stored record keeps the
// authoritative per-payment flag.
export function isStripeTestMode(
  secretKey: string = getStripeSecretKey()
): boolean {
  return secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_");
}
