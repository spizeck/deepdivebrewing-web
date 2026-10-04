// Pure configuration lookup for the QuickBooks Online integration
// (issue #161). Kept server-import-only in practice (it reads secrets) but
// dependency-free like lib/resend-config.ts so the validation is
// unit-testable.
//
// Environment separation is explicit: QBO_ENVIRONMENT decides which Intuit
// credential pair and which QBO company universe this deployment talks to.
// Sandbox and production never share a base URL, and an unrecognized value
// fails closed — the app refuses to guess where financial data would go.
import { isQboEnvironment, type QboEnvironment } from "@/lib/qbo-common";
import { QboConfigError } from "@/lib/qbo-errors";

// Intuit OAuth 2.0 endpoints — identical for development and production
// credentials (per the Intuit OpenID discovery document).
export const QBO_AUTHORIZE_URL =
  "https://appcenter.intuit.com/connect/oauth2";
export const QBO_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QBO_REVOKE_URL =
  "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

export const QBO_ACCOUNTING_SCOPE = "com.intuit.quickbooks.accounting";

// Intuit deprecated minor versions 1–74 on 2025-08-01; requests below 75 are
// silently upgraded, so pin the current floor explicitly.
export const QBO_MINOR_VERSION = "75";

const QBO_API_BASES: Record<QboEnvironment, string> = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
};

// The QuickBooks API host is a function of the *configured* environment
// only — never derived from request input.
export function qboApiBaseUrl(environment: QboEnvironment): string {
  return QBO_API_BASES[environment];
}

export function getQboEnvironment(
  raw: string | undefined = process.env.QBO_ENVIRONMENT
): QboEnvironment {
  const value = (raw ?? "").trim().toLowerCase();
  if (isQboEnvironment(value)) return value;
  if (!value) {
    throw new QboConfigError(
      'QBO_ENVIRONMENT is not configured (expected "sandbox" or "production").'
    );
  }
  throw new QboConfigError(
    'QBO_ENVIRONMENT has an unsupported value — expected "sandbox" or "production".'
  );
}

export interface QboAppConfig {
  environment: QboEnvironment;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// Non-throwing probe for the admin status surface: a deployment without the
// integration configured should render "not configured", not an error.
export function isQboConfigured(): boolean {
  try {
    getQboEnvironment();
  } catch {
    return false;
  }
  return Boolean(
    process.env.QBO_CLIENT_ID?.trim() &&
      process.env.QBO_CLIENT_SECRET?.trim() &&
      process.env.QBO_REDIRECT_URI?.trim()
  );
}

function getQboRedirectUri(): string {
  const raw = process.env.QBO_REDIRECT_URI?.trim();
  if (!raw) {
    throw new QboConfigError("QBO_REDIRECT_URI is not configured.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new QboConfigError("QBO_REDIRECT_URI is not a valid URL.");
  }
  // OAuth redirect targets must be HTTPS outside local development —
  // Intuit enforces the same rule when the URI is registered.
  const isLocalhost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) {
    throw new QboConfigError(
      "QBO_REDIRECT_URI must be an https URL (http is allowed for localhost only)."
    );
  }
  return raw;
}

// Loads and validates the OAuth application config. Missing or invalid
// values throw QboConfigError — the integration fails closed rather than
// issuing a request with partial credentials.
export function loadQboConfig(): QboAppConfig {
  const clientId = process.env.QBO_CLIENT_ID?.trim();
  if (!clientId) {
    throw new QboConfigError("QBO_CLIENT_ID is not configured.");
  }
  const clientSecret = process.env.QBO_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    throw new QboConfigError("QBO_CLIENT_SECRET is not configured.");
  }
  return {
    environment: getQboEnvironment(),
    clientId,
    clientSecret,
    redirectUri: getQboRedirectUri(),
  };
}

// Verifier token for POST /api/webhooks/quickbooks — the `intuit-signature`
// HMAC key. Unset means the endpoint is not configured and must refuse
// work rather than process unverified events.
export function getQboWebhookVerifierToken(): string | undefined {
  return process.env.QBO_WEBHOOK_VERIFIER_TOKEN?.trim() || undefined;
}
