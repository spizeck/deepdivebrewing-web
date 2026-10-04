// Normalized error taxonomy for the QuickBooks Online provider boundary
// (issue #161). Provider responses, OAuth failures, and transport errors
// never cross this boundary raw — they can echo request internals and
// token material. Callers see only the kind, a safe message, an HTTP-ish
// status for the admin API, and a correlation id when Intuit supplies one
// (`intuit_tid`).

export type QboErrorKind =
  // The integration is not correctly configured on this deployment
  // (missing env, bad encryption key, unsupported environment).
  | "configuration"
  // Intuit rejected the grant — refresh token revoked/expired or the access
  // token is no longer honored. The remedy is reauthorization.
  | "authorization_expired"
  // A refresh attempt failed for a non-authorization reason.
  | "refresh_failed"
  // The grant is valid but cannot perform the operation (HTTP 403).
  | "permission_denied"
  // The provider rejected the request payload (HTTP 400-family).
  | "validation"
  // Intuit throttled the request (HTTP 429).
  | "rate_limited"
  // Transport failure or provider 5xx — retryable once idempotent.
  | "unavailable"
  // Anything that doesn't fit the above — treated as provider-side.
  | "unexpected";

const DEFAULT_STATUS: Record<QboErrorKind, number> = {
  configuration: 500,
  authorization_expired: 409,
  refresh_failed: 502,
  permission_denied: 403,
  validation: 400,
  rate_limited: 429,
  unavailable: 502,
  unexpected: 502,
};

export class QboError extends Error {
  // Safe to surface `message`/`status` to admin callers — see
  // lib/api-error.ts. Messages must never embed provider bodies or tokens.
  public readonly clientSafe = true;

  constructor(
    message: string,
    public readonly kind: QboErrorKind,
    public status: number = DEFAULT_STATUS[kind],
    public readonly correlationId?: string
  ) {
    super(message);
    this.name = "QboError";
  }
}

export class QboConfigError extends QboError {
  constructor(message: string) {
    super(message, "configuration");
    this.name = "QboConfigError";
  }
}
