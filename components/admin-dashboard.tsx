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
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";
import { ref, uploadBytes } from "firebase/storage";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { auth, db, storage } from "@/lib/firebase";
import { ADMIN_EMAIL_SET } from "@/lib/admin-emails";
import type { Beer, Venue } from "@/lib/types";

interface RebuildMeta {
  cooldownUntil?: number;
  lastTriggeredAt?: number;
  lastTriggeredBy?: string;
  contentUpdatedAt?: number;
  contentUpdatedBy?: string;
  lastContentUpdateType?: "beer" | "venue";
}

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

  const beerOptions = useMemo(
    () => beers.map((beer) => ({ slug: beer.slug, name: beer.name })),
    [beers]
  );

  const isAuthorized = useMemo(
    () => !!user?.email && ADMIN_EMAIL_SET.has(user.email.toLowerCase()),
    [user?.email]
  );

  const rebuildCooldownMs = Math.max(0, rebuildCooldownUntil - currentTimeMs);
  const isRebuildDisabled = isTriggeringRebuild || rebuildCooldownMs > 0;
  const hasUpdatesSinceLastRebuild =
    !!rebuildMeta.contentUpdatedAt &&
    (!rebuildMeta.lastTriggeredAt || rebuildMeta.contentUpdatedAt > rebuildMeta.lastTriggeredAt);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (nextUser && ADMIN_EMAIL_SET.has((nextUser.email ?? "").toLowerCase())) {
        await loadData();
        await loadRebuildMeta();
      }
    });

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
    setVenueForm(found);
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
      getDocs(query(collection(db, "beers"), orderBy("sortOrder", "asc"))),
      getDocs(query(collection(db, "venues"), orderBy("sortOrder", "asc"))),
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
    const metaSnap = await getDoc(doc(db, "meta", "siteRebuild"));
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
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (error) {
      console.error(error);
      setStatusMessage("Sign-in failed. Please try again.");
    }
  }

  async function handleSignOut() {
    await signOut(auth);
    setStatusMessage("");
  }

  function formatDuration(ms: number) {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  }

  function formatDateTime(value?: number) {
    if (!value) return "—";
    return new Date(value).toLocaleString();
  }

  async function markContentUpdated(updateType: "beer" | "venue") {
    const now = Date.now();
    const email = user?.email ?? "unknown";

    await setDoc(
      doc(db, "meta", "siteRebuild"),
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
        doc(db, "meta", "siteRebuild"),
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
      await setDoc(doc(db, "beers", payload.slug), payload, { merge: true });
      await markContentUpdated("beer");
      setStatusMessage("Beer saved.");
      await loadData();
      setSelectedBeerSlug(payload.slug);
    } catch (error) {
      console.error(error);
      setStatusMessage("Failed to save beer.");
    } finally {
      setIsSaving(false);
    }
  }

  async function saveVenue() {
    if (!venueForm.slug || !venueForm.name) {
      setStatusMessage("Venue name and slug are required.");
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
      await setDoc(doc(db, "venues", payload.slug), payload, { merge: true });
      await markContentUpdated("venue");
      setStatusMessage("Venue saved.");
      await loadData();
      setSelectedVenueSlug(payload.slug);
    } catch (error) {
      console.error(error);
      setStatusMessage("Failed to save venue.");
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
      await uploadBytes(ref(storage, objectPath), file);
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

  function toggleBeerSlugSelection(
    slug: string,
    checked: boolean,
    setSelection: (updater: (prev: string[]) => string[]) => void
  ) {
    setSelection((prev) => {
      if (checked) {
        return prev.includes(slug) ? prev : [...prev, slug];
      }
      return prev.filter((value) => value !== slug);
    });
  }

  function selectionSummary(selection: string[]) {
    if (selection.length === 0) return "No beers selected";
    return selection
      .map((slug) => beers.find((beer) => beer.slug === slug)?.name ?? slug)
      .join(", ");
  }

  if (!authReady) {
    return <p className="text-sm text-muted-foreground">Loading admin...</p>;
  }

  if (!user) {
    return (
      <div className="rounded-lg border border-stone bg-paper p-6">
        <h1 className="text-2xl font-bold tracking-tight">Admin Dashboard</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in with an authorized Google account to manage beers and venue data.
        </p>
        <Button onClick={handleGoogleSignIn} className="mt-4">Sign in with Google</Button>
        {statusMessage && <p className="mt-3 text-sm text-ember">{statusMessage}</p>}
      </div>
    );
  }

  if (!isAuthorized) {
    return (
      <div className="rounded-lg border border-stone bg-paper p-6">
        <h1 className="text-2xl font-bold tracking-tight">Admin Dashboard</h1>
        <p className="mt-2 text-sm text-ember">
          {user.email} is not authorized for admin access.
        </p>
        <Button onClick={handleSignOut} variant="outline" className="mt-4">
          Sign out
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-stone bg-paper p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Admin Dashboard</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Signed in as {user.email}
            </p>
          </div>
          <Button onClick={handleSignOut} variant="outline">
            Sign out
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            onClick={triggerRebuild}
            disabled={isRebuildDisabled}
            variant="outline"
          >
            {isTriggeringRebuild
              ? "Triggering rebuild..."
              : rebuildCooldownMs > 0
                ? `Rebuild cooldown (${formatDuration(rebuildCooldownMs)})`
                : "Rebuild Site"}
          </Button>
          {rebuildCooldownMs > 0 && (
            <p className="text-xs text-muted-foreground">
              Rebuild can be triggered again after cooldown expires.
            </p>
          )}
        </div>
        <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
          <p>
            Last rebuild by: <span className="font-medium text-ink">{rebuildMeta.lastTriggeredBy ?? "—"}</span>
          </p>
          <p>
            Last rebuild at: <span className="font-medium text-ink">{formatDateTime(rebuildMeta.lastTriggeredAt)}</span>
          </p>
        </div>
        {hasUpdatesSinceLastRebuild && (
          <div className="mt-4 rounded-md border border-amber-400/50 bg-amber-100/60 px-3 py-2 text-sm text-amber-900">
            Content was updated after the last rebuild
            {rebuildMeta.lastContentUpdateType ? ` (${rebuildMeta.lastContentUpdateType})` : ""}
            . Latest update by {rebuildMeta.contentUpdatedBy ?? "—"} at {formatDateTime(rebuildMeta.contentUpdatedAt)}.
          </div>
        )}
        {statusMessage && <p className="mt-3 text-sm text-ocean">{statusMessage}</p>}
      </div>

      <Tabs defaultValue="beers">
        <TabsList>
          <TabsTrigger value="beers">Beers</TabsTrigger>
          <TabsTrigger value="venues">Venues</TabsTrigger>
          {hasUpdatesSinceLastRebuild && (
            <span className="ml-2 inline-flex items-center rounded-full border border-amber-500/40 bg-amber-100/70 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-900">
              Needs Rebuild
            </span>
          )}
        </TabsList>

        <TabsContent value="beers">
          <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
            <div className="rounded-lg border border-stone bg-paper p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">Beer Records</h2>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSelectedBeerSlug("");
                    setBeerForm(DEFAULT_BEER);
                    setBeerTastingNotesInput("");
                  }}
                >
                  New
                </Button>
              </div>
              <div className="space-y-1">
                {beers.map((beer) => (
                  <button
                    key={beer.slug}
                    type="button"
                    onClick={() => setSelectedBeerSlug(beer.slug)}
                    className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${
                      selectedBeerSlug === beer.slug ? "bg-stone/40" : "hover:bg-stone/20"
                    }`}
                  >
                    {beer.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-stone bg-paper p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Name</span>
                  <input className="w-full rounded-md border border-stone px-3 py-2" value={beerForm.name} onChange={(e) => setBeerForm((prev) => ({ ...prev, name: e.target.value }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Slug</span>
                  <input className="w-full rounded-md border border-stone px-3 py-2" value={beerForm.slug} onChange={(e) => setBeerForm((prev) => ({ ...prev, slug: e.target.value.trim().toLowerCase() }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Style</span>
                  <input className="w-full rounded-md border border-stone px-3 py-2" value={beerForm.style} onChange={(e) => setBeerForm((prev) => ({ ...prev, style: e.target.value }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Status</span>
                  <select className="w-full rounded-md border border-stone px-3 py-2" value={beerForm.status} onChange={(e) => setBeerForm((prev) => ({ ...prev, status: e.target.value as Beer["status"] }))}>
                    <option value="core">Core</option>
                    <option value="seasonal">Seasonal</option>
                    <option value="limited">Limited</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">ABV</span>
                  <input type="number" step="0.1" className="w-full rounded-md border border-stone px-3 py-2" value={beerForm.abv} onChange={(e) => setBeerForm((prev) => ({ ...prev, abv: Number(e.target.value) }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Sort Order</span>
                  <input type="number" className="w-full rounded-md border border-stone px-3 py-2" value={beerForm.sortOrder} onChange={(e) => setBeerForm((prev) => ({ ...prev, sortOrder: Number(e.target.value) }))} />
                </label>
              </div>

              <label className="mt-4 block text-sm">
                <span className="mb-1 block font-medium">Short Description</span>
                <textarea className="w-full rounded-md border border-stone px-3 py-2" rows={3} value={beerForm.descriptionShort} onChange={(e) => setBeerForm((prev) => ({ ...prev, descriptionShort: e.target.value }))} />
              </label>

              <label className="mt-4 block text-sm">
                <span className="mb-1 block font-medium">Tasting Notes (comma-separated)</span>
                <input className="w-full rounded-md border border-stone px-3 py-2" value={beerTastingNotesInput} onChange={(e) => setBeerTastingNotesInput(e.target.value)} />
              </label>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Card Image Path</span>
                  <input className="w-full rounded-md border border-stone px-3 py-2" value={beerForm.images.cardPath} onChange={(e) => setBeerForm((prev) => ({ ...prev, images: { ...prev.images, cardPath: e.target.value } }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Hero Image Path</span>
                  <input className="w-full rounded-md border border-stone px-3 py-2" value={beerForm.images.heroPath} onChange={(e) => setBeerForm((prev) => ({ ...prev, images: { ...prev.images, heroPath: e.target.value } }))} />
                </label>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Upload Card Image</span>
                  <input type="file" accept="image/*" onChange={(e) => uploadBeerImage("card", e.target.files?.[0] ?? null, beerForm.slug)} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Upload Hero Image</span>
                  <input type="file" accept="image/*" onChange={(e) => uploadBeerImage("hero", e.target.files?.[0] ?? null, beerForm.slug)} />
                </label>
              </div>

              <div className="mt-4 flex items-center gap-3">
                <Button onClick={saveBeer} disabled={isSaving}>Save Beer</Button>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" checked={beerForm.isPublic} onChange={(e) => setBeerForm((prev) => ({ ...prev, isPublic: e.target.checked }))} />
                  Public
                </label>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="venues">
          <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
            <div className="rounded-lg border border-stone bg-paper p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">Venue Records</h2>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setSelectedVenueSlug("");
                    setVenueForm(DEFAULT_VENUE);
                    setVenueCarriesSelection([]);
                    setVenueTapSelection([]);
                    setVenueCanSelection([]);
                  }}
                >
                  New
                </Button>
              </div>
              <div className="space-y-1">
                {venues.map((venue) => (
                  <button
                    key={venue.slug}
                    type="button"
                    onClick={() => setSelectedVenueSlug(venue.slug)}
                    className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${
                      selectedVenueSlug === venue.slug ? "bg-stone/40" : "hover:bg-stone/20"
                    }`}
                  >
                    {venue.name}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-stone bg-paper p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Name</span>
                  <input className="w-full rounded-md border border-stone px-3 py-2" value={venueForm.name} onChange={(e) => setVenueForm((prev) => ({ ...prev, name: e.target.value }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Slug</span>
                  <input className="w-full rounded-md border border-stone px-3 py-2" value={venueForm.slug} onChange={(e) => setVenueForm((prev) => ({ ...prev, slug: e.target.value.trim().toLowerCase() }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Type</span>
                  <select className="w-full rounded-md border border-stone px-3 py-2" value={venueForm.type} onChange={(e) => setVenueForm((prev) => ({ ...prev, type: e.target.value as Venue["type"] }))}>
                    <option value="bar_restaurant">Bar / Restaurant</option>
                    <option value="retail">Retail</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Location Name</span>
                  <input className="w-full rounded-md border border-stone px-3 py-2" value={venueForm.locationName} onChange={(e) => setVenueForm((prev) => ({ ...prev, locationName: e.target.value }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Sort Order</span>
                  <input type="number" className="w-full rounded-md border border-stone px-3 py-2" value={venueForm.sortOrder} onChange={(e) => setVenueForm((prev) => ({ ...prev, sortOrder: Number(e.target.value) }))} />
                </label>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <details className="text-sm">
                  <summary className="cursor-pointer rounded-md border border-stone px-3 py-2 font-medium">
                    Carries Beers
                  </summary>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {selectionSummary(venueCarriesSelection)}
                  </p>
                  <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border border-stone p-2">
                    {beerOptions.map((beer) => (
                      <label key={`carries-${beer.slug}`} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={venueCarriesSelection.includes(beer.slug)}
                          onChange={(e) =>
                            toggleBeerSlugSelection(
                              beer.slug,
                              e.target.checked,
                              setVenueCarriesSelection
                            )
                          }
                        />
                        <span>{beer.name}</span>
                      </label>
                    ))}
                  </div>
                </details>

                <details className="text-sm">
                  <summary className="cursor-pointer rounded-md border border-stone px-3 py-2 font-medium">
                    On Tap
                  </summary>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {selectionSummary(venueTapSelection)}
                  </p>
                  <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border border-stone p-2">
                    {beerOptions.map((beer) => (
                      <label key={`tap-${beer.slug}`} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={venueTapSelection.includes(beer.slug)}
                          onChange={(e) =>
                            toggleBeerSlugSelection(
                              beer.slug,
                              e.target.checked,
                              setVenueTapSelection
                            )
                          }
                        />
                        <span>{beer.name}</span>
                      </label>
                    ))}
                  </div>
                </details>

                <details className="text-sm">
                  <summary className="cursor-pointer rounded-md border border-stone px-3 py-2 font-medium">
                    In Can
                  </summary>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {selectionSummary(venueCanSelection)}
                  </p>
                  <div className="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-md border border-stone p-2">
                    {beerOptions.map((beer) => (
                      <label key={`can-${beer.slug}`} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={venueCanSelection.includes(beer.slug)}
                          onChange={(e) =>
                            toggleBeerSlugSelection(
                              beer.slug,
                              e.target.checked,
                              setVenueCanSelection
                            )
                          }
                        />
                        <span>{beer.name}</span>
                      </label>
                    ))}
                  </div>
                </details>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Website</span>
                  <input className="w-full rounded-md border border-stone px-3 py-2" value={venueForm.links.website ?? ""} onChange={(e) => setVenueForm((prev) => ({ ...prev, links: { ...prev.links, website: e.target.value } }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Maps Link</span>
                  <input className="w-full rounded-md border border-stone px-3 py-2" value={venueForm.links.maps ?? ""} onChange={(e) => setVenueForm((prev) => ({ ...prev, links: { ...prev.links, maps: e.target.value } }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Instagram</span>
                  <input className="w-full rounded-md border border-stone px-3 py-2" value={venueForm.links.instagram ?? ""} onChange={(e) => setVenueForm((prev) => ({ ...prev, links: { ...prev.links, instagram: e.target.value } }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Facebook</span>
                  <input className="w-full rounded-md border border-stone px-3 py-2" value={venueForm.links.facebook ?? ""} onChange={(e) => setVenueForm((prev) => ({ ...prev, links: { ...prev.links, facebook: e.target.value } }))} />
                </label>
              </div>

              <label className="mt-4 block text-sm">
                <span className="mb-1 block font-medium">Public Notes</span>
                <textarea className="w-full rounded-md border border-stone px-3 py-2" rows={3} value={venueForm.notesPublic ?? ""} onChange={(e) => setVenueForm((prev) => ({ ...prev, notesPublic: e.target.value }))} />
              </label>

              <div className="mt-4 flex items-center gap-3">
                <Button onClick={saveVenue} disabled={isSaving}>Save Venue</Button>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" checked={venueForm.isPublic} onChange={(e) => setVenueForm((prev) => ({ ...prev, isPublic: e.target.checked }))} />
                  Public
                </label>
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
