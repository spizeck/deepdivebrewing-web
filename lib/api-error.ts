import { NextResponse } from "next/server";
import { logError, type LogContext } from "@/lib/log";

// Errors marked `clientSafe` expose a deliberate message + status to the
// caller (AdminAuthError is the canonical example). Everything else is
// treated as internal: logged in full server-side and answered with a
// generic fallback so provider details and stack-derived messages never
// reach the client.
interface ClientSafeError extends Error {
  status: number;
  clientSafe: true;
}

export function isClientSafeError(error: unknown): error is ClientSafeError {
  return (
    error instanceof Error &&
    (error as { clientSafe?: unknown }).clientSafe === true &&
    typeof (error as { status?: unknown }).status === "number"
  );
}

export function apiErrorResponse(
  error: unknown,
  opts: { fallback: string; event: string; context?: LogContext }
): NextResponse {
  if (isClientSafeError(error)) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: error.status }
    );
  }
  logError(opts.event, error, opts.context);
  return NextResponse.json(
    { ok: false, error: opts.fallback },
    { status: 500 }
  );
}
