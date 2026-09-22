import type { AdminRole } from "@/lib/types";

// Client-side post-grant session refresh (Issue #94).
//
// When the server grants admin access (invitation acceptance, superadmin
// bootstrap), it updates the user's custom claims and adminUsers record — but
// the browser still holds the pre-grant ID token. The Firebase client SDK
// keeps serving that stale token until it is force-refreshed, so a UI that
// only checked claims once (at sign-in) keeps rendering "not authorized"
// until the user signs out and back in.
//
// This helper performs the canonical re-evaluation instead: force-refresh the
// ID token so it carries the new claims, then ask the server (/api/admin/me)
// whether the refreshed credentials satisfy the full authorization invariant —
// valid admin claim AND an existing, active adminUsers record whose role
// matches. Only a server-confirmed result returns a role; the caller must not
// treat anything else as authorized.

export interface AdminAccessCheckResult {
  isAdmin: boolean;
  role?: AdminRole;
}

export interface AdminSessionRefreshDeps {
  /** Force-refreshes the Firebase ID token — `user.getIdToken(true)`. */
  forceRefreshIdToken: () => Promise<string>;
  /** Canonical re-check of the refreshed token — GET /api/admin/me. */
  checkAdminAccess: (idToken: string) => Promise<AdminAccessCheckResult>;
  /** Injectable for tests; defaults to a real timer. */
  delay?: (ms: number) => Promise<void>;
}

// Custom claims are normally visible in the very next forced token refresh,
// but the Auth backend can lag briefly after setCustomUserClaims. A small
// bounded retry covers that without arbitrary waiting or an unbounded loop.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 750;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Refreshes the caller's credentials and re-evaluates admin authorization.
 * Returns the server-confirmed role, or null when the refreshed credentials
 * still do not satisfy canonical authorization (or refresh/check fails) —
 * callers must treat null as "not authorized".
 */
export async function refreshAdminAccess(
  deps: AdminSessionRefreshDeps
): Promise<AdminRole | null> {
  const delay = deps.delay ?? defaultDelay;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const idToken = await deps.forceRefreshIdToken();
      const check = await deps.checkAdminAccess(idToken);
      if (
        check.isAdmin === true &&
        (check.role === "admin" || check.role === "superadmin")
      ) {
        return check.role;
      }
    } catch {
      // Transient refresh/check failure — fall through to the bounded retry.
    }

    if (attempt < MAX_ATTEMPTS) {
      await delay(RETRY_DELAY_MS);
    }
  }

  return null;
}
