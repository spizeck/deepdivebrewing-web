import { NextRequest, NextResponse } from "next/server";
import { normalizeEmail, requireAdminActor } from "@/lib/admin-auth";
import { getBearerToken } from "@/lib/api-auth";
import { apiErrorResponse } from "@/lib/api-error";
import { getRequestId, logError, logInfo } from "@/lib/log";

const REBUILD_COOLDOWN_MS = Number(
  process.env.ADMIN_REBUILD_COOLDOWN_MS ?? 10 * 60 * 1000
);
let cooldownUntil = 0;

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req.headers);
  try {
    const deployHookUrl =
      process.env.VERCEL_DEPLOY_HOOK_URL?.trim() ||
      process.env.VERCEL_REBUILD_DEPLOY_HOOK_URL?.trim() ||
      "";
    if (!deployHookUrl) {
      // Names only — never log the hook URL value itself.
      logError("admin_rebuild.misconfigured", undefined, {
        missing: "VERCEL_DEPLOY_HOOK_URL",
        requestId,
      });
      return NextResponse.json(
        {
          ok: false,
          error:
            "VERCEL_DEPLOY_HOOK_URL is not configured for this deployment environment.",
          expectedEnvVars: [
            "VERCEL_DEPLOY_HOOK_URL",
            "VERCEL_REBUILD_DEPLOY_HOOK_URL",
          ],
          runtimeNodeEnv: process.env.NODE_ENV ?? "unknown",
        },
        { status: 500 }
      );
    }

    const now = Date.now();

    if (now < cooldownUntil) {
      return NextResponse.json(
        {
          ok: false,
          error: "Rebuild is on cooldown.",
          cooldownUntil,
        },
        { status: 429 }
      );
    }

    const idToken = getBearerToken(req);
    if (!idToken) {
      return NextResponse.json(
        { ok: false, error: "Missing auth token." },
        { status: 401 }
      );
    }

    // Verified token + admin claim + existing active adminUsers record with a
    // matching role (see requireAdminActor).
    const actor = await requireAdminActor(idToken);
    const email = normalizeEmail(actor.token.email);

    const hookResponse = await fetch(deployHookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ trigger: "admin-dashboard", email, role: actor.claims.role }),
    });

    if (!hookResponse.ok) {
      // Log only the upstream status — the response body could echo the
      // deploy-hook URL and is not needed for diagnosis.
      logError("admin_rebuild.hook_failed", undefined, {
        upstreamStatus: hookResponse.status,
        requestId,
      });
      return NextResponse.json(
        {
          ok: false,
          error: "Vercel deploy hook failed.",
        },
        { status: 502 }
      );
    }

    const nextCooldownUntil = Date.now() + REBUILD_COOLDOWN_MS;
    cooldownUntil = nextCooldownUntil;

    logInfo("admin_rebuild.triggered", {
      uid: actor.token.uid,
      role: actor.claims.role,
      requestId,
    });

    return NextResponse.json({
      ok: true,
      cooldownUntil: nextCooldownUntil,
      message: "Rebuild triggered successfully.",
    });
  } catch (error) {
    return apiErrorResponse(error, {
      fallback: "Failed to trigger rebuild.",
      event: "admin_rebuild.unexpected",
      context: { requestId },
    });
  }
}
