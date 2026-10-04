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

// Minimal sign-in/authorization shell for admin sub-pages (/admin/trade).
// The full bootstrap + invitation flow stays on /admin — a signed-in user
// without admin claims is pointed there rather than duplicating that flow.
export function AdminAuthGate({
  heading,
  description,
  children,
}: {
  heading: string;
  // Surface-specific sign-in prompt — each admin sub-page names what the
  // authorized account manages (trade leads, payments, QuickBooks, …).
  description: string;
  children: (user: User) => ReactNode;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  // Claims are resolved asynchronously after each auth event; while pending,
  // the gate must show neither the workspace nor a false "not authorized".
  const [claimsResolved, setClaimsResolved] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  // uid of the most recent auth event — a slow getIdTokenResult must never
  // apply claims to a user that has since signed out or been replaced.
  const latestUidRef = useRef<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    try {
      unsub = onAuthStateChanged(
        getFirebaseAuth(),
        async (nextUser) => {
          const uid = nextUser?.uid ?? null;
          latestUidRef.current = uid;
          setUser(nextUser);
          setIsAdmin(false);
          setClaimsResolved(false);
          setAuthReady(true);
          if (!nextUser) {
            setClaimsResolved(true);
            return;
          }
          try {
            const tokenResult = await getIdTokenResult(nextUser, true);
            // A newer auth event superseded this resolution — drop it.
            if (latestUidRef.current !== uid) return;
            const claims = tokenResult.claims as {
              admin?: boolean;
              role?: string;
            };
            setIsAdmin(
              claims.admin === true &&
                (claims.role === "admin" || claims.role === "superadmin")
            );
          } catch (error) {
            console.error("Failed to resolve admin session:", error);
          }
          if (latestUidRef.current === uid) {
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
  }, []);

  async function handleGoogleSignIn() {
    setStatusMessage("");
    try {
      await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
    } catch (error) {
      console.error(error);
      setStatusMessage("Sign-in failed. Please try again.");
    }
  }

  if (!authReady || (user && !claimsResolved)) {
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

  return <>{children(user)}</>;
}
