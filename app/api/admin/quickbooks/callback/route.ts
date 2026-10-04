import { type NextRequest, NextResponse } from "next/server";
import { getAdminUser } from "@/lib/admin-users";
import { getRequestId, logError, logWarn } from "@/lib/log";
import { QboError } from "@/lib/qbo-errors";
import {
  completeQboAuthorization,
  consumeQboOAuthState,
} from "@/lib/qbo";
import { QBO_OAUTH_COOKIE } from "@/lib/qbo-callback-cookie";

// Intuit OAuth redirect target (issue #161). This endpoint cannot require
// the admin bearer token — the browser arrives here from Intuit — so the
// trust boundary is the one-time OAuth state: it must match the httpOnly
// cookie set at connect time AND a persisted, unexpired, unconsumed record
// created by an authorized admin. A consumed state proves who initiated
// the flow — the initiating admin's record is re-checked below before any
// provider exchange, since they may have been disabled in between.
//
// The route never renders anything and never echoes provider data — it
// redirects back to the admin page with a coarse outcome parameter only.

const ADMIN_PAGE = "/admin/integrations/quickbooks";

function redirectToAdmin(req: NextRequest, params: Record<string, string>) {
  const url = new URL(ADMIN_PAGE, req.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = NextResponse.redirect(url);
  res.cookies.delete(QBO_OAUTH_COOKIE);
  return res;
}

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const params = req.nextUrl.searchParams;

  const providerError = params.get("error");
  if (providerError) {
    // Admin declined consent or Intuit refused the request.
    logWarn("qbo.oauth.failed", { requestId, reason: "provider_denied" });
    return redirectToAdmin(req, { qbo: "error", qbo_reason: "denied" });
  }

  const code = params.get("code");
  const state = params.get("state");
  const realmId = params.get("realmId");
  const cookieState = req.cookies.get(QBO_OAUTH_COOKIE)?.value;

  if (!code || !state || !realmId) {
    return redirectToAdmin(req, {
      qbo: "error",
      qbo_reason: "invalid_callback",
    });
  }

  // The state must arrive via the same browser that started the flow —
  // a state injected into someone else's callback fails here before any
  // Firestore work happens.
  if (!cookieState || cookieState !== state) {
    logWarn("qbo.oauth.failed", { requestId, reason: "state_cookie_mismatch" });
    return redirectToAdmin(req, {
      qbo: "error",
      qbo_reason: "state_invalid",
    });
  }

  try {
    const consumed = await consumeQboOAuthState(state);
    if (consumed.verdict !== "ok") {
      logWarn("qbo.oauth.failed", { requestId, reason: consumed.verdict });
      return redirectToAdmin(req, {
        qbo: "error",
        qbo_reason:
          consumed.verdict === "consumed"
            ? "state_replayed"
            : consumed.verdict === "expired"
              ? "state_expired"
              : "state_invalid",
      });
    }

    // The consumed state identifies who started the flow; it does not
    // prove they are still allowed to act. Re-verify the adminUsers
    // record — an admin disabled or removed between connect and callback
    // must not complete the connection. Both admin roles may connect, so
    // any still-active record passes regardless of role.
    const initiator = await getAdminUser(consumed.uid);
    if (initiator?.status !== "active") {
      logWarn("qbo.oauth.failed", {
        requestId,
        reason: "initiating_admin_inactive",
      });
      return redirectToAdmin(req, {
        qbo: "error",
        qbo_reason: "connect_failed",
      });
    }

    await completeQboAuthorization({
      code,
      realmId,
      uid: consumed.uid,
      email: consumed.email,
    });
    return redirectToAdmin(req, { qbo: "connected" });
  } catch (error) {
    const reason =
      error instanceof QboError && error.kind === "configuration"
        ? "not_configured"
        : "connect_failed";
    logError("qbo.oauth.failed", error, { requestId });
    return redirectToAdmin(req, { qbo: "error", qbo_reason: reason });
  }
}
