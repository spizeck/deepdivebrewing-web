import { NextRequest, NextResponse } from "next/server";
import { ADMIN_EMAIL_SET } from "@/lib/admin-emails";
import { getFirebaseAdminAuth } from "@/lib/firebase-admin";

const REBUILD_COOLDOWN_MS = Number(
  process.env.ADMIN_REBUILD_COOLDOWN_MS ?? 10 * 60 * 1000
);
let cooldownUntil = 0;

function getBearerToken(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
}

export async function POST(req: NextRequest) {
  try {
    const deployHookUrl = process.env.VERCEL_DEPLOY_HOOK_URL;
    if (!deployHookUrl) {
      return NextResponse.json(
        { ok: false, error: "VERCEL_DEPLOY_HOOK_URL is not configured." },
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

    const adminAuth = getFirebaseAdminAuth();
    const decoded = await adminAuth.verifyIdToken(idToken);
    const email = decoded.email?.toLowerCase();

    if (!email || !ADMIN_EMAIL_SET.has(email)) {
      return NextResponse.json(
        { ok: false, error: "Not authorized to trigger rebuild." },
        { status: 403 }
      );
    }

    const hookResponse = await fetch(deployHookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ trigger: "admin-dashboard", email }),
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
    return NextResponse.json(
      { ok: false, error: "Failed to trigger rebuild." },
      { status: 500 }
    );
  }
}
