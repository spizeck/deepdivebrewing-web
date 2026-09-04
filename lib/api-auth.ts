import "server-only";
import { type NextRequest, NextResponse } from "next/server";

export function getBearerToken(req: NextRequest): string | null {
  const authHeader = req.headers.get("authorization") ?? "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

export function unauthorizedResponse(message = "Unauthorized."): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status: 401 });
}

export function forbiddenResponse(message = "Forbidden."): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status: 403 });
}

export function badRequestResponse(message: string): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

export function serverErrorResponse(message = "Internal server error."): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}
