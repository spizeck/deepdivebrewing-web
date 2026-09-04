import { NextRequest, NextResponse } from "next/server";
import { assertAnyAdmin, getAdminClaims, normalizeEmail, verifyAdminIdToken } from "@/lib/admin-auth";
import { getAdminUser } from "@/lib/admin-users";
import { getBearerToken } from "@/lib/api-auth";

const REBUILD_COOLDOWN_MS = Number(
  process.env.ADMIN_REBUILD_COOLDOWN_MS ?? 10 * 60 * 1000
);
let cooldownUntil = 0;

export async function POST(req: NextRequest) {
  try {
    const deployHookUrl =
      process.env.VERCEL_DEPLOY_HOOK_URL?.trim() ||
      process.env.VERCEL_REBUILD_DEPLOY_HOOK_URL?.trim() ||
      "";
    if (!deployHookUrl) {
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

    const decoded = await verifyAdminIdToken(idToken);
    assertAnyAdmin(decoded);

    const adminRecord = await getAdminUser(decoded.uid);
    if (adminRecord?.status === "disabled") {
      return NextResponse.json(
        { ok: false, error: "Administrator account is disabled." },
        { status: 403 }
      );
    }

    const claims = getAdminClaims(decoded)!;
    const email = normalizeEmail(decoded.email);

    const hookResponse = await fetch(deployHookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ trigger: "admin-dashboard", email, role: claims.role }),
    });

    if (!hookResponse.ok) {
      const errorText = await hookResponse.text();
      return NextResponse.json(
        {
          ok: false,
          error: "Vercel deploy hook failed.",
          details: errorText,
        },
        { status: 502 }
      );
    }

    const nextCooldownUntil = Date.now() + REBUILD_COOLDOWN_MS;
    cooldownUntil = nextCooldownUntil;

    return NextResponse.json({
      ok: true,
      cooldownUntil: nextCooldownUntil,
      message: "Rebuild triggered successfully.",
    });
  } catch (error) {
    console.error("Rebuild trigger error:", error);
    const message = error instanceof Error ? error.message : "Failed to trigger rebuild.";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
