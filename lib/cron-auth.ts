import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

// Shared-secret gate for Vercel Cron invocations (issue #183). Vercel
// sends `Authorization: Bearer $CRON_SECRET` on every cron request when
// the CRON_SECRET environment variable is set — no separate admin or
// Firebase identity exists on a cron call, so the secret is the entire
// trust boundary. Fails closed: with no secret configured, nothing is
// authorized.
export function isAuthorizedCronRequest(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return false;
  const expected = Buffer.from(secret);
  const provided = Buffer.from(token);
  return (
    provided.length === expected.length &&
    timingSafeEqual(provided, expected)
  );
}
