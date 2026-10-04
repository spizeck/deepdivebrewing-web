import { type NextRequest, NextResponse } from "next/server";
import { requireAdminActor } from "@/lib/admin-auth";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId } from "@/lib/log";
import { createQboAuthorizationRequest } from "@/lib/qbo";
import { QBO_OAUTH_COOKIE } from "@/lib/qbo-callback-cookie";
import { QBO_OAUTH_STATE_TTL_MS } from "@/lib/qbo-protocol";

// Starts the QuickBooks OAuth flow (issue #161): the admin receives the
// Intuit authorization URL and a one-time state cookie. The cookie
// cross-checks the callback's `state` parameter against the persisted
// record so the flow is bound to this admin's browser.

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  const idToken = getBearerToken(req);
  if (!idToken) return unauthorizedResponse();

  try {
    const actor = await requireAdminActor(idToken);
    const { authorizationUrl, state } =
      await createQboAuthorizationRequest(actor);
    const res = NextResponse.json({ ok: true, authorizationUrl });
    // Lax so it rides along on Intuit's top-level redirect back to us;
    // httpOnly so only the server sees it; Secure whenever this request
    // itself arrived over https (every deployed environment — a plain
    // http localhost dev flow keeps the cookie too).
    res.cookies.set(QBO_OAUTH_COOKIE, state, {
      httpOnly: true,
      secure: req.nextUrl.protocol === "https:",
      sameSite: "lax",
      maxAge: Math.ceil(QBO_OAUTH_STATE_TTL_MS / 1000),
      path: "/",
    });
    return res;
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Could not start the QuickBooks connection.",
      event: "qbo.connect_failed",
      context: { requestId },
    });
  }
}
