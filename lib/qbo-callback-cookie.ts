// The httpOnly cookie that binds an in-flight QuickBooks OAuth flow to the
// initiating browser (issue #161). Shared between the connect route (which
// sets it) and the callback route (which cross-checks it).
export const QBO_OAUTH_COOKIE = "qbo_oauth_state";
