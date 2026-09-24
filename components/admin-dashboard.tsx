"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
} from "firebase/firestore";
import {
  getIdTokenResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { ref, uploadBytes } from "firebase/storage";
import { Button } from "@/components/ui/button";
import {
  getFirebaseAuth,
  getFirebaseDb,
  getFirebaseStorage,
} from "@/lib/firebase";
import {
  AdminWorkspace,
  type RebuildMeta,
} from "@/components/admin-workspace";
import { refreshAdminAccess } from "@/lib/admin-session-refresh";
import { resolveVenueIsland } from "@/lib/venue-filters";
import { isVenueIsland } from "@/lib/venue-islands";
import type { AdminRole, Beer, Venue } from "@/lib/types";

const DEFAULT_BEER: Beer = {
  name: "",
  slug: "",
  style: "",
  abv: 0,
  ibu: null,
  srm: null,
  status: "core",
  descriptionShort: "",
  tastingNotes: [],
  images: {
    cardPath: "",
    heroPath: "",
  },
  isPublic: true,
  sortOrder: 999,
};

const DEFAULT_VENUE: Venue = {
  name: "",
  slug: "",
  type: "bar_restaurant",
  locationName: "",
  carriesBeerSlugs: [],
  tapBeerSlugs: [],
  canBeerSlugs: [],
  isPublic: true,
  sortOrder: 999,
  links: {},
  notesPublic: "",
};

function csvToArray(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function arrayToCsv(value?: string[]): string {
  return (value ?? []).join(", ");
}

export function AdminDashboard() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [beers, setBeers] = useState<Beer[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [selectedBeerSlug, setSelectedBeerSlug] = useState<string>("");
  const [selectedVenueSlug, setSelectedVenueSlug] = useState<string>("");
  const [beerForm, setBeerForm] = useState<Beer>(DEFAULT_BEER);
  const [venueForm, setVenueForm] = useState<Venue>(DEFAULT_VENUE);
  const [beerTastingNotesInput, setBeerTastingNotesInput] = useState("");
  const [venueCarriesSelection, setVenueCarriesSelection] = useState<string[]>([]);
  const [venueTapSelection, setVenueTapSelection] = useState<string[]>([]);
  const [venueCanSelection, setVenueCanSelection] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isTriggeringRebuild, setIsTriggeringRebuild] = useState(false);
  const [rebuildCooldownUntil, setRebuildCooldownUntil] = useState(0);
  const [currentTimeMs, setCurrentTimeMs] = useState(Date.now());
  const [rebuildMeta, setRebuildMeta] = useState<RebuildMeta>({});
  const [role, setRole] = useState<AdminRole | null>(null);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [pendingInvitation, setPendingInvitation] = useState<{
    id: string;
    email: string;
    role: AdminRole;
  } | null>(null);
  const [isAcceptingInvitation, setIsAcceptingInvitation] = useState(false);
  // Post-grant credential refresh (Issue #94): after the server grants admin
  // access, the ID token must be force-refreshed and authorization re-checked
  // before the workspace renders.
  const [isRefreshingAccess, setIsRefreshingAccess] = useState(false);
  const [accessRefreshFailed, setAccessRefreshFailed] = useState(false);

  const isAuthorized = useMemo(() => role === "admin" || role === "superadmin", [role]);
  const isSuperAdmin = useMemo(() => role === "superadmin", [role]);

  const rebuildCooldownMs = Math.max(0, rebuildCooldownUntil - currentTimeMs);
  const isRebuildDisabled = isTriggeringRebuild || rebuildCooldownMs > 0;
  const hasUpdatesSinceLastRebuild =
    !!rebuildMeta.contentUpdatedAt &&
    (!rebuildMeta.lastTriggeredAt || rebuildMeta.contentUpdatedAt > rebuildMeta.lastTriggeredAt);

  useEffect(() => {
    // Missing/invalid Firebase config (e.g. a preview without env) must not
    // crash the route — surface the sign-in shell instead.
    let unsub: () => void;
    try {
      unsub = onAuthStateChanged(
        getFirebaseAuth(),
        async (nextUser) => {
          setUser(nextUser);
          setShowBootstrap(false);
          setRole(null);
          setPendingInvitation(null);
          setIsRefreshingAccess(false);
          setAccessRefreshFailed(false);

          if (nextUser) {
            try {
              const tokenResult = await getIdTokenResult(nextUser, true);
              const claims = tokenResult.claims as Partial<{ admin?: boolean; role?: string }>;
              if (
                claims.admin === true &&
                (claims.role === "superadmin" || claims.role === "admin")
              ) {
                setRole(claims.role as AdminRole);
                await loadData();
                await loadRebuildMeta();
              } else {
                // The user is signed in but has no admin claim yet. Check whether this account
                // matches the configured bootstrap superadmin email or has a pending invitation.
                const idToken = await nextUser.getIdToken();
                const res = await fetch("/api/admin/me", {
                  headers: { Authorization: `Bearer ${idToken}` },
                });
                const me = (await res.json()) as {
                  isAdmin?: boolean;
                  isBootstrapEmail?: boolean;
                  pendingInvitation?: { id: string; email: string; role: AdminRole } | null;
                };
                if (!me.isAdmin && me.isBootstrapEmail) {
                  setShowBootstrap(true);
                } else if (!me.isAdmin && me.pendingInvitation) {
                  setPendingInvitation(me.pendingInvitation);
                }
              }
            } catch (error) {
              console.error("Failed to resolve admin session:", error);
            }
          }

          setAuthReady(true);
        },
        (error) => {
          console.error("Auth state listener failed:", error);
          setStatusMessage("Sign-in is currently unavailable.");
          setAuthReady(true);
        }
      );
    } catch (error) {
      console.error("Firebase Auth is unavailable:", error);
      setStatusMessage("Sign-in is currently unavailable.");
      setAuthReady(true);
      return;
    }

    return () => unsub();
  }, []);

  useEffect(() => {
    const found = beers.find((beer) => beer.slug === selectedBeerSlug);
    if (!found) return;
    setBeerForm(found);
    setBeerTastingNotesInput(arrayToCsv(found.tastingNotes));
  }, [selectedBeerSlug, beers]);

  useEffect(() => {
    const found = venues.find((venue) => venue.slug === selectedVenueSlug);
    if (!found) return;
    // Legacy records lack the canonical island field (Issue #134): preselect
    // the island resolved from the old free-text location so saving writes
    // the field without manual repair. Unresolvable records leave the
    // required select unset instead of guessing.
    setVenueForm({ ...found, island: resolveVenueIsland(found) });
    setVenueCarriesSelection(found.carriesBeerSlugs ?? []);
    setVenueTapSelection(found.tapBeerSlugs ?? []);
    setVenueCanSelection(found.canBeerSlugs ?? []);
  }, [selectedVenueSlug, venues]);

  useEffect(() => {
    if (rebuildCooldownUntil <= Date.now()) {
      return;
    }

    const interval = window.setInterval(() => {
      setCurrentTimeMs(Date.now());
    }, 1000);

    return () => window.clearInterval(interval);
  }, [rebuildCooldownUntil]);

  async function loadData() {
    const [beerSnap, venueSnap] = await Promise.all([
      getDocs(
        query(collection(getFirebaseDb(), "beers"), orderBy("sortOrder", "asc"))
      ),
      getDocs(
        query(collection(getFirebaseDb(), "venues"), orderBy("sortOrder", "asc"))
      ),
    ]);

    const nextBeers = beerSnap.docs.map((d) => d.data() as Beer);
    const nextVenues = venueSnap.docs.map((d) => d.data() as Venue);
    setBeers(nextBeers);
    setVenues(nextVenues);

    if (nextBeers.length > 0) {
      setSelectedBeerSlug((prev) => prev || nextBeers[0].slug);
    }

    if (nextVenues.length > 0) {
      setSelectedVenueSlug((prev) => prev || nextVenues[0].slug);
    }
  }

  async function loadRebuildMeta() {
    const metaSnap = await getDoc(doc(getFirebaseDb(), "meta", "siteRebuild"));
    if (!metaSnap.exists()) {
      setRebuildMeta({});
      return;
    }

    const meta = metaSnap.data() as RebuildMeta;
    setRebuildMeta(meta);

    if (typeof meta.cooldownUntil === "number") {
      setRebuildCooldownUntil(meta.cooldownUntil);
      setCurrentTimeMs(Date.now());
    }
  }

  async function handleGoogleSignIn() {
    setStatusMessage("");
    try {
      await signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
    } catch (error) {
      console.error(error);
      setStatusMessage("Sign-in failed. Please try again.");
    }
  }

  async function handleSignOut() {
    await signOut(getFirebaseAuth());
    setStatusMessage("");
    setRole(null);
    setShowBootstrap(false);
    setPendingInvitation(null);
  }

  // Re-evaluates authorization after a server-side grant (invitation
  // acceptance or bootstrap). Force-refreshes the ID token so it carries the
  // new custom claims, then has the server re-check the canonical invariant
  // (admin claim + active, role-matching adminUsers record). Only a
  // server-confirmed result sets role — a stale or missing claim never
  // authorizes the workspace.
  async function refreshAdminSession(): Promise<boolean> {
    if (!user) return false;
    // Bind the refresh to the identity that initiated it: the token refresh
    // and canonical re-check are async, and sign-out or an account switch can
    // land mid-flight. A confirmed role for the old identity must never be
    // applied after the current user has changed.
    const initiatingUser = user;
    const expectedUid = user.uid;
    const auth = getFirebaseAuth();
    const isInitiatorCurrent = () => auth.currentUser?.uid === expectedUid;

    const confirmedRole = await refreshAdminAccess({
      forceRefreshIdToken: () => initiatingUser.getIdToken(true),
      checkAdminAccess: async (idToken) => {
        const res = await fetch("/api/admin/me", {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const me = (await res.json()) as { isAdmin?: boolean; role?: AdminRole };
        return { isAdmin: me.isAdmin === true, role: me.role };
      },
      isInitiatorCurrent,
    });

    // Final guard immediately before the authorization transition — no state
    // writes may happen for a stale identity.
    if (!confirmedRole || !isInitiatorCurrent()) return false;

    setRole(confirmedRole);
    setPendingInvitation(null);
    setShowBootstrap(false);
    setAccessRefreshFailed(false);
    setStatusMessage("");
    await loadData();
    await loadRebuildMeta();
    return true;
  }

  async function handleBootstrap() {
    if (!user) return;
    setIsBootstrapping(true);
    setStatusMessage("");
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/admin/bootstrap", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok || !data.ok) {
        setStatusMessage(data.error ?? "Bootstrap failed.");
        return;
      }
      setShowBootstrap(false);
      setIsRefreshingAccess(true);
      const refreshed = await refreshAdminSession();
      if (!refreshed) {
        setAccessRefreshFailed(true);
      }
    } catch (error) {
      console.error(error);
      setStatusMessage("Bootstrap failed. Please try again.");
    } finally {
      setIsBootstrapping(false);
      setIsRefreshingAccess(false);
    }
  }

  async function handleAcceptInvitation() {
    if (!user || !pendingInvitation) return;
    setIsAcceptingInvitation(true);
    setStatusMessage("");
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/admin/invitations/accept", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok || !data.ok) {
        setStatusMessage(data.error ?? "Failed to accept invitation.");
        return;
      }
      setPendingInvitation(null);
      setIsRefreshingAccess(true);
      const refreshed = await refreshAdminSession();
      if (!refreshed) {
        setAccessRefreshFailed(true);
      }
    } catch (error) {
      console.error(error);
      setStatusMessage("Failed to accept invitation. Please try again.");
    } finally {
      setIsAcceptingInvitation(false);
      setIsRefreshingAccess(false);
    }
  }

  // Last-resort recovery when the automatic post-grant refresh could not
  // confirm access: re-runs the same force-refresh + canonical re-check.
  async function handleRetryAccessRefresh() {
    setIsRefreshingAccess(true);
    setStatusMessage("");
    try {
      const refreshed = await refreshAdminSession();
      if (!refreshed) {
        setStatusMessage(
          "Access is still being finalized. Try again in a moment, or sign out and back in."
        );
      }
    } finally {
      setIsRefreshingAccess(false);
    }
  }

  function getErrorMessage(error: unknown, fallback: string) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      "message" in error
    ) {
      const code = String((error as { code: unknown }).code);
      const message = String((error as { message: unknown }).message);
      if (code.includes("permission-denied")) {
        return `${fallback} Firestore permission denied.`;
      }
      return `${fallback} ${code}: ${message}`;
    }

    return fallback;
  }

  async function markContentUpdated(updateType: "beer" | "venue") {
    const now = Date.now();
    const email = user?.email ?? "unknown";

    await setDoc(
      doc(getFirebaseDb(), "meta", "siteRebuild"),
      {
        contentUpdatedAt: now,
        contentUpdatedBy: email,
        lastContentUpdateType: updateType,
      },
      { merge: true }
    );

    setRebuildMeta((prev) => ({
      ...prev,
      contentUpdatedAt: now,
      contentUpdatedBy: email,
      lastContentUpdateType: updateType,
    }));
  }

  async function triggerRebuild() {
    if (!user || isRebuildDisabled) {
      return;
    }

    setIsTriggeringRebuild(true);
    setStatusMessage("");

    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/admin/rebuild", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      });

      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        message?: string;
        cooldownUntil?: number;
      };

      if (!response.ok || !result.ok) {
        if (result.cooldownUntil) {
          setRebuildCooldownUntil(result.cooldownUntil);
          setCurrentTimeMs(Date.now());
        }
        setStatusMessage(result.error ?? "Failed to trigger rebuild.");
        return;
      }

      if (result.cooldownUntil) {
        setRebuildCooldownUntil(result.cooldownUntil);
        setCurrentTimeMs(Date.now());
      }

      const lastTriggeredAt = Date.now();
      await setDoc(
        doc(getFirebaseDb(), "meta", "siteRebuild"),
        {
          cooldownUntil: result.cooldownUntil ?? lastTriggeredAt,
          lastTriggeredAt,
          lastTriggeredBy: user.email ?? "unknown",
        },
        { merge: true }
      );

      setRebuildMeta((prev) => ({
        ...prev,
        cooldownUntil: result.cooldownUntil ?? lastTriggeredAt,
        lastTriggeredAt,
        lastTriggeredBy: user.email ?? "unknown",
      }));

      setStatusMessage(result.message ?? "Rebuild triggered.");
    } catch (error) {
      console.error(error);
      setStatusMessage("Failed to trigger rebuild.");
    } finally {
      setIsTriggeringRebuild(false);
    }
  }

  async function saveBeer() {
    if (!beerForm.slug || !beerForm.name) {
      setStatusMessage("Beer name and slug are required.");
      return;
    }

    setIsSaving(true);
    setStatusMessage("");
    try {
      const payload: Beer = {
        ...beerForm,
        tastingNotes: csvToArray(beerTastingNotesInput),
      };
      await setDoc(doc(getFirebaseDb(), "beers", payload.slug), payload, {
        merge: true,
      });

      let metadataWarning = "";
      try {
        await markContentUpdated("beer");
      } catch (metadataError) {
        console.warn("Beer saved but failed to update rebuild metadata:", metadataError);
        metadataWarning = " Beer saved, but rebuild alert metadata could not be updated.";
      }

      setStatusMessage(`Beer saved.${metadataWarning}`);
      await loadData();
      setSelectedBeerSlug(payload.slug);
    } catch (error) {
      console.error(error);
      setStatusMessage(getErrorMessage(error, "Failed to save beer."));
    } finally {
      setIsSaving(false);
    }
  }

  async function saveVenue() {
    if (!venueForm.slug || !venueForm.name) {
      setStatusMessage("Venue name and slug are required.");
      return;
    }

    if (!isVenueIsland(venueForm.island)) {
      setStatusMessage("Select an island for this venue.");
      return;
    }

    setIsSaving(true);
    setStatusMessage("");
    try {
      const payload: Venue = {
        ...venueForm,
        carriesBeerSlugs: venueCarriesSelection,
        tapBeerSlugs: venueTapSelection,
        canBeerSlugs: venueCanSelection,
      };
      await setDoc(doc(getFirebaseDb(), "venues", payload.slug), payload, {
        merge: true,
      });

      let metadataWarning = "";
      try {
        await markContentUpdated("venue");
      } catch (metadataError) {
        console.warn("Venue saved but failed to update rebuild metadata:", metadataError);
        metadataWarning = " Venue saved, but rebuild alert metadata could not be updated.";
      }

      setStatusMessage(`Venue saved.${metadataWarning}`);
      await loadData();
      setSelectedVenueSlug(payload.slug);
    } catch (error) {
      console.error(error);
      setStatusMessage(getErrorMessage(error, "Failed to save venue."));
    } finally {
      setIsSaving(false);
    }
  }

  async function uploadBeerImage(
    kind: "card" | "hero",
    file: File | null,
    slug: string
  ) {
    if (!file || !slug) return;

    const extension = file.name.split(".").pop() || "jpg";
    const filename = `${slug}_${kind}_${Date.now()}.${extension}`;
    const objectPath = `beers/${slug}/${filename}`;

    setStatusMessage(`Uploading ${kind} image...`);
    try {
      await uploadBytes(ref(getFirebaseStorage(), objectPath), file);
      setBeerForm((prev) => ({
        ...prev,
        images: {
          ...prev.images,
          [kind === "card" ? "cardPath" : "heroPath"]: objectPath,
        },
      }));
      setStatusMessage(`${kind === "card" ? "Card" : "Hero"} image uploaded. Save beer to persist.`);
    } catch (error) {
      console.error(error);
      setStatusMessage("Image upload failed.");
    }
  }

  if (!authReady) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading admin...
      </p>
    );
  }

  if (!user) {
    return (
      <div className="rounded-lg border border-stone bg-paper p-6">
        <h1 className="text-2xl font-bold tracking-tight">Admin Dashboard</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in with an authorized Google account to manage beers and venue data.
        </p>
        <Button onClick={handleGoogleSignIn} className="mt-4">Sign in with Google</Button>
        {statusMessage && (
          <p role="alert" className="mt-3 text-sm text-ember">
            {statusMessage}
          </p>
        )}
      </div>
    );
  }

  if (!isAuthorized) {
    const isActionVisible =
      showBootstrap || pendingInvitation || isRefreshingAccess || accessRefreshFailed;
    return (
      <div className="rounded-lg border border-stone bg-paper p-6">
        <h1 className="text-2xl font-bold tracking-tight">Admin Dashboard</h1>
        {isRefreshingAccess ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            Refreshing admin access...
          </p>
        ) : accessRefreshFailed ? (
          <>
            <p role="status" className="mt-2 text-sm text-muted-foreground">
              Your admin access was granted, but this session could not pick it up
              automatically.
            </p>
            <Button
              onClick={handleRetryAccessRefresh}
              disabled={isRefreshingAccess}
              className="mt-4"
            >
              Refresh admin access
            </Button>
          </>
        ) : showBootstrap ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              This account is configured as the bootstrap superadmin. Complete setup to grant
              administrator access.
            </p>
            <Button
              onClick={handleBootstrap}
              disabled={isBootstrapping}
              className="mt-4"
            >
              {isBootstrapping ? "Completing setup..." : "Complete Superadmin Setup"}
            </Button>
          </>
        ) : pendingInvitation ? (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              You have a pending administrator invitation ({pendingInvitation.role}).
            </p>
            <Button
              onClick={handleAcceptInvitation}
              disabled={isAcceptingInvitation}
              className="mt-4"
            >
              {isAcceptingInvitation ? "Accepting..." : "Accept Invitation"}
            </Button>
          </>
        ) : (
          <p role="status" className="mt-2 text-sm text-ember">
            {user.email} is not authorized for admin access.
          </p>
        )}
        <Button onClick={handleSignOut} variant="outline" className="mt-4">
          Sign out
        </Button>
        {statusMessage && (
          <p
            role="status"
            className={`mt-3 text-sm ${isActionVisible ? "text-ocean" : "text-ember"}`}
          >
            {statusMessage}
          </p>
        )}
      </div>
    );
  }

  return (
    <AdminWorkspace
      userEmail={user.email}
      isSuperAdmin={isSuperAdmin}
      accessUser={user}
      onSignOut={handleSignOut}
      statusMessage={statusMessage}
      onStatusMessage={setStatusMessage}
      isTriggeringRebuild={isTriggeringRebuild}
      rebuildCooldownMs={rebuildCooldownMs}
      isRebuildDisabled={isRebuildDisabled}
      onTriggerRebuild={triggerRebuild}
      rebuildMeta={rebuildMeta}
      hasUpdatesSinceLastRebuild={hasUpdatesSinceLastRebuild}
      beers={beers}
      selectedBeerSlug={selectedBeerSlug}
      onSelectBeer={setSelectedBeerSlug}
      onNewBeer={() => {
        setSelectedBeerSlug("");
        setBeerForm(DEFAULT_BEER);
        setBeerTastingNotesInput("");
      }}
      beerForm={beerForm}
      setBeerForm={setBeerForm}
      beerTastingNotesInput={beerTastingNotesInput}
      setBeerTastingNotesInput={setBeerTastingNotesInput}
      onSaveBeer={saveBeer}
      onUploadBeerImage={uploadBeerImage}
      venues={venues}
      selectedVenueSlug={selectedVenueSlug}
      onSelectVenue={setSelectedVenueSlug}
      onNewVenue={() => {
        setSelectedVenueSlug("");
        setVenueForm(DEFAULT_VENUE);
        setVenueCarriesSelection([]);
        setVenueTapSelection([]);
        setVenueCanSelection([]);
      }}
      venueForm={venueForm}
      setVenueForm={setVenueForm}
      venueCarriesSelection={venueCarriesSelection}
      setVenueCarriesSelection={setVenueCarriesSelection}
      venueTapSelection={venueTapSelection}
      setVenueTapSelection={setVenueTapSelection}
      venueCanSelection={venueCanSelection}
      setVenueCanSelection={setVenueCanSelection}
      onSaveVenue={saveVenue}
      isSaving={isSaving}
    />
  );
}
