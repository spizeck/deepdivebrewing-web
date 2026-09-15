import { type NextRequest, NextResponse } from "next/server";
import { getAdminClaims, verifyAdminIdToken } from "@/lib/admin-auth";
import { getProtectedAdminEmail, isProtectedAdmin } from "@/lib/admin-common";
import { checkAdminActorRecord } from "@/lib/admin-policy";
import { getAdminUser } from "@/lib/admin-users";
import { getPendingInvitationByEmail } from "@/lib/admin-invitations";
import { getBearerToken, unauthorizedResponse } from "@/lib/api-auth";

export async function GET(req: NextRequest) {
  const idToken = getBearerToken(req);
  if (!idToken) {
    return unauthorizedResponse("Missing bearer token.");
  }

  try {
    const decoded = await verifyAdminIdToken(idToken);
    const claims = getAdminClaims(decoded);
    const adminRecord = await getAdminUser(decoded.uid);

    if (claims) {
      // Claims alone are not sufficient: the record must exist, be active, and
      // agree on role (same invariant as requireAdminActor).
      const check = checkAdminActorRecord({ claims, record: adminRecord });
      if (!check.allowed) {
        return NextResponse.json(
          {
            ok: false,
            isAdmin: false,
            disabled: adminRecord?.status === "disabled",
            error: check.error,
            email: decoded.email,
          },
          { status: 403 }
        );
      }

      return NextResponse.json({
        ok: true,
        isAdmin: true,
        isSuperAdmin: claims.role === "superadmin",
        role: claims.role,
        uid: decoded.uid,
        email: decoded.email,
      });
    }

    // No admin claim yet; indicate whether this account is the configured bootstrap email
    // or has a pending invitation.
    const isBootstrapEmail =
      !!decoded.email_verified &&
      !!getProtectedAdminEmail() &&
      isProtectedAdmin(decoded.email);
    const pendingInvitation =
      decoded.email_verified && decoded.email
        ? await getPendingInvitationByEmail(decoded.email)
        : null;

    return NextResponse.json({
      ok: true,
      isAdmin: false,
      isBootstrapEmail,
      pendingInvitation: pendingInvitation
        ? { id: pendingInvitation.id, email: pendingInvitation.email, role: pendingInvitation.role }
        : null,
      email: decoded.email,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Authentication failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 401 });
  }
}
