"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  getIdTokenResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { Button } from "@/components/ui/button";
import { getFirebaseAuth } from "@/lib/firebase";
import {
  ADMIN_PERMISSION_LABELS,
  isAdminPermission,
  type AdminPermission,
} from "@/lib/admin-permissions";

// Minimal sign-in/authorization shell for admin sub-pages (/admin/trade).
// The full bootstrap + invitation flow stays on /admin — a signed-in user
// without admin claims is pointed there rather than duplicating that flow.
//
// Capability gating (issue #210): when `requiredPermission` is set, the gate
// also fetches /api/admin/me and renders an access-denied state unless the
// live adminUsers record grants that capability. This is presentation only —
// every API the workspace calls enforces the same permission server-side.
export function AdminAuthGate({
  heading,
  description,
  requiredPermission,
  children,
}: {
  heading: string;
  // Surface-specific sign-in prompt — each admin sub-page names what the
  // authorized account manages (trade leads, payments, QuickBooks, …).
  description: string;
  requiredPermission?: AdminPermission;
  children: (user: User) => ReactNode;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  // Claims are resolved asynchronously after each auth event; while pending,
  // the gate must show neither the workspace nor a false "not authorized".
  const [claimsResolved, setClaimsResolved] = useState(false);
  // Effective permissions resolved from /api/admin/me. null = still pending
  // (or not applicable because no permission is required); [] is a resolved
  // empty set — fail closed.
  const [permissions, setPermissions] = useState<AdminPermission[] | null>(
    null
  );
  const [permissionCheckFailed, setPermissionCheckFailed] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  // uid + monotonically increasing event index of the most recent auth
  // event — a slow getIdTokenResult or /api/admin/me fetch must never apply
  // its result to a user that has since signed out or been replaced, and a
  // same-UID sign-out/sign-in cycle must not resurrect an older response.
  const latestUidRef = useRef<string | null>(null);
  const latestAuthEventRef = useRef(0);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    try {
      unsub = onAuthStateChanged(
        getFirebaseAuth(),
        async (nextUser) => {
          const uid = nextUser?.uid ?? null;
          const authEvent = ++latestAuthEventRef.current;
          latestUidRef.current = uid;
          const isStale = () =>
            latestUidRef.current !== uid ||
            latestAuthEventRef.current !== authEvent;
          setUser(nextUser);
          setIsAdmin(false);
          setClaimsResolved(false);
          setPermissions(null);
          setPermissionCheckFailed(false);
          setAuthReady(true);
          if (!nextUser) {
            setClaimsResolved(true);
            return;
          }
          try {
            const tokenResult = await getIdTokenResult(nextUser, true);
            // A newer auth event superseded this resolution — drop it.
            if (isStale()) return;
            const claims = tokenResult.claims as {
              admin?: boolean;
              role?: string;
            };
            const admin =
              claims.admin === true &&
              (claims.role === "admin" || claims.role === "superadmin");
            setIsAdmin(admin);
            if (admin && requiredPermission) {
              // Permissions live on the adminUsers record, not in claims —
              // resolve them from the canonical /api/admin/me check so the
              // gate sees exactly what the server enforces right now.
              try {
                const idToken = await nextUser.getIdToken();
                const res = await fetch("/api/admin/me", {
                  headers: { Authorization: `Bearer ${idToken}` },
                });
                // A non-OK response is a failed check, not an empty
                // permission set — show "could not be verified" rather
                // than a misleading access-denied state.
                if (!res.ok) {
                  throw new Error(`/api/admin/me responded ${res.status}`);
                }
                const me = (await res.json()) as { permissions?: unknown };
                if (isStale()) return;
                setPermissions(
                  Array.isArray(me.permissions)
                    ? me.permissions.filter(isAdminPermission)
                    : []
                );
              } catch {
                if (isStale()) return;
                setPermissionCheckFailed(true);
              }
            }
          } catch (error) {
            console.error("Failed to resolve admin session:", error);
          }
          if (!isStale()) {
            setClaimsResolved(true);
          }
        },
        (error) => {
          console.error("Auth state listener failed:", error);
          setStatusMessage("Sign-in is currently unavailable.");
          setAuthReady(true);
        }
      );
    } catch (error) {
      console.error("Firebase Auth is unavailable:", error);
      // Deferred so the fallback isn't a synchronous setState in the effect.
      queueMicrotask(() => {
        setStatusMessage("Sign-in is currently unavailable.");
        setAuthReady(true);
      });
      return;
    }
    return () => unsub();
  }, [requiredPermission]);

  async function handleGoogleSignIn() {
    setStatusMessage("");
    try {
      await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
    } catch (error) {
      console.error(error);
      setStatusMessage("Sign-in failed. Please try again.");
    }
  }

  const permissionPending =
    isAdmin && !!requiredPermission && !permissionCheckFailed && permissions === null;
  const permissionDenied =
    isAdmin &&
    !!requiredPermission &&
    !permissionCheckFailed &&
    permissions !== null &&
    !permissions.includes(requiredPermission);

  if (!authReady || (user && (!claimsResolved || permissionPending))) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading admin...
      </p>
    );
  }

  if (!user) {
    return (
      <div className="rounded-lg border border-stone bg-paper p-6">
        <h1 className="text-2xl font-bold tracking-tight">{heading}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        <Button onClick={handleGoogleSignIn} className="mt-4">
          Sign in with Google
        </Button>
        {statusMessage && (
          <p role="alert" className="mt-3 text-sm text-ember">
            {statusMessage}
          </p>
        )}
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="rounded-lg border border-stone bg-paper p-6">
        <h1 className="text-2xl font-bold tracking-tight">{heading}</h1>
        <p role="status" className="mt-2 text-sm text-ember">
          {user.email} is not authorized for admin access.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          If you were invited, accept the invitation from the{" "}
          <Link href="/admin" className="font-medium text-ocean hover:underline">
            admin dashboard
          </Link>
          .
        </p>
        <Button
          onClick={() => void signOut(getFirebaseAuth())}
          variant="outline"
          className="mt-4"
        >
          Sign out
        </Button>
      </div>
    );
  }

  if (permissionCheckFailed) {
    return (
      <div className="rounded-lg border border-stone bg-paper p-6">
        <h1 className="text-2xl font-bold tracking-tight">{heading}</h1>
        <p role="alert" className="mt-2 text-sm text-ember">
          Your admin permissions could not be verified. Sign out and sign back
          in, or try again later.
        </p>
        <Button
          onClick={() => void signOut(getFirebaseAuth())}
          variant="outline"
          className="mt-4"
        >
          Sign out
        </Button>
      </div>
    );
  }

  if (permissionDenied) {
    const label = requiredPermission
      ? ADMIN_PERMISSION_LABELS[requiredPermission].label
      : heading;
    return (
      <div className="rounded-lg border border-stone bg-paper p-6">
        <h1 className="text-2xl font-bold tracking-tight">{heading}</h1>
        <p role="status" className="mt-2 text-sm text-ember">
          {user.email} does not have {label} access.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask a superadmin to grant this permission from the admin dashboard,
          or return to{" "}
          <Link href="/admin" className="font-medium text-ocean hover:underline">
            the admin dashboard
          </Link>
          .
        </p>
        <Button
          onClick={() => void signOut(getFirebaseAuth())}
          variant="outline"
          className="mt-4"
        >
          Sign out
        </Button>
      </div>
    );
  }

  return <>{children(user)}</>;
}
