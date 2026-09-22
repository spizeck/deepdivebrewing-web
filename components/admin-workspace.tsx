"use client";

import type { Dispatch, SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AdminAccessPanel,
  type AdminPanelUser,
} from "@/components/admin-access";
import type { Beer, Venue } from "@/lib/types";

export interface RebuildMeta {
  cooldownUntil?: number;
  lastTriggeredAt?: number;
  lastTriggeredBy?: string;
  contentUpdatedAt?: number;
  contentUpdatedBy?: string;
  lastContentUpdateType?: "beer" | "venue";
}

export interface AdminWorkspaceProps {
  userEmail: string | null;
  isSuperAdmin: boolean;
  accessUser: AdminPanelUser;
  onSignOut: () => void;
  statusMessage: string;
  onStatusMessage: (message: string) => void;
  // Rebuild controls
  isTriggeringRebuild: boolean;
  rebuildCooldownMs: number;
  isRebuildDisabled: boolean;
  onTriggerRebuild: () => void;
  rebuildMeta: RebuildMeta;
  hasUpdatesSinceLastRebuild: boolean;
  // Beer records + form
  beers: Beer[];
  selectedBeerSlug: string;
  onSelectBeer: (slug: string) => void;
  onNewBeer: () => void;
  beerForm: Beer;
  setBeerForm: Dispatch<SetStateAction<Beer>>;
  beerTastingNotesInput: string;
  setBeerTastingNotesInput: Dispatch<SetStateAction<string>>;
  onSaveBeer: () => void;
  onUploadBeerImage: (
    kind: "card" | "hero",
    file: File | null,
    slug: string
  ) => void;
  // Venue records + form
  venues: Venue[];
  selectedVenueSlug: string;
  onSelectVenue: (slug: string) => void;
  onNewVenue: () => void;
  venueForm: Venue;
  setVenueForm: Dispatch<SetStateAction<Venue>>;
  venueCarriesSelection: string[];
  setVenueCarriesSelection: Dispatch<SetStateAction<string[]>>;
  venueTapSelection: string[];
  setVenueTapSelection: Dispatch<SetStateAction<string[]>>;
  venueCanSelection: string[];
  setVenueCanSelection: Dispatch<SetStateAction<string[]>>;
  onSaveVenue: () => void;
  isSaving: boolean;
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

// Input/select borders use ink at 50% so every form control boundary is
// visible against the paper background (WCAG 1.4.11 non-text contrast).
const fieldClass = "w-full rounded-md border border-ink/50 px-3 py-2";

export function AdminWorkspace({
  userEmail,
  isSuperAdmin,
  accessUser,
  onSignOut,
  statusMessage,
  onStatusMessage,
  isTriggeringRebuild,
  rebuildCooldownMs,
  isRebuildDisabled,
  onTriggerRebuild,
  rebuildMeta,
  hasUpdatesSinceLastRebuild,
  beers,
  selectedBeerSlug,
  onSelectBeer,
  onNewBeer,
  beerForm,
  setBeerForm,
  beerTastingNotesInput,
  setBeerTastingNotesInput,
  onSaveBeer,
  onUploadBeerImage,
  venues,
  selectedVenueSlug,
  onSelectVenue,
  onNewVenue,
  venueForm,
  setVenueForm,
  venueCarriesSelection,
  setVenueCarriesSelection,
  venueTapSelection,
  setVenueTapSelection,
  venueCanSelection,
  setVenueCanSelection,
  onSaveVenue,
  isSaving,
}: AdminWorkspaceProps) {
  const beerOptions = beers.map((beer) => ({ slug: beer.slug, name: beer.name }));

  function selectionSummary(selection: string[]) {
    if (selection.length === 0) return "No beers selected";
    return selection
      .map((slug) => beers.find((beer) => beer.slug === slug)?.name ?? slug)
      .join(", ");
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-stone bg-paper p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Admin Dashboard</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Signed in as {userEmail}
            </p>
          </div>
          <Button onClick={onSignOut} variant="outline">
            Sign out
          </Button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            onClick={onTriggerRebuild}
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
        {statusMessage && (
          <p role="status" className="mt-3 text-sm text-ocean">
            {statusMessage}
          </p>
        )}
      </div>

      <Tabs defaultValue="beers">
        <div className="flex flex-wrap items-center gap-2">
          <TabsList>
            <TabsTrigger value="beers">Beers</TabsTrigger>
            <TabsTrigger value="venues">Venues</TabsTrigger>
            {isSuperAdmin && <TabsTrigger value="access">Access</TabsTrigger>}
          </TabsList>
          {hasUpdatesSinceLastRebuild && (
            <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-100/70 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-amber-900">
              Needs Rebuild
            </span>
          )}
        </div>

        <TabsContent value="beers">
          <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
            <div className="rounded-lg border border-stone bg-paper p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">Beer Records</h2>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="New beer record"
                  onClick={() => {
                    onNewBeer();
                    document.getElementById("beer-name")?.focus();
                  }}
                >
                  New
                </Button>
              </div>
              <ul className="space-y-1">
                {beers.map((beer) => (
                  <li key={beer.slug}>
                    <button
                      type="button"
                      aria-current={selectedBeerSlug === beer.slug}
                      onClick={() => onSelectBeer(beer.slug)}
                      className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${
                        selectedBeerSlug === beer.slug ? "bg-stone/40" : "hover:bg-stone/20"
                      }`}
                    >
                      {beer.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-lg border border-stone bg-paper p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">
                    Name
                    <span aria-hidden="true" className="text-ember"> *</span>
                  </span>
                  <input id="beer-name" required className={fieldClass} value={beerForm.name} onChange={(e) => setBeerForm((prev) => ({ ...prev, name: e.target.value }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">
                    Slug
                    <span aria-hidden="true" className="text-ember"> *</span>
                  </span>
                  <input required className={fieldClass} value={beerForm.slug} onChange={(e) => setBeerForm((prev) => ({ ...prev, slug: e.target.value.trim().toLowerCase() }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Style</span>
                  <input className={fieldClass} value={beerForm.style} onChange={(e) => setBeerForm((prev) => ({ ...prev, style: e.target.value }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Status</span>
                  <select className={fieldClass} value={beerForm.status} onChange={(e) => setBeerForm((prev) => ({ ...prev, status: e.target.value as Beer["status"] }))}>
                    <option value="core">Core</option>
                    <option value="seasonal">Seasonal</option>
                    <option value="limited">Limited</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">ABV</span>
                  <input type="number" step="0.1" className={fieldClass} value={beerForm.abv} onChange={(e) => setBeerForm((prev) => ({ ...prev, abv: Number(e.target.value) }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Sort Order</span>
                  <input type="number" className={fieldClass} value={beerForm.sortOrder} onChange={(e) => setBeerForm((prev) => ({ ...prev, sortOrder: Number(e.target.value) }))} />
                </label>
              </div>

              <label className="mt-4 block text-sm">
                <span className="mb-1 block font-medium">Short Description</span>
                <textarea className={fieldClass} rows={3} value={beerForm.descriptionShort} onChange={(e) => setBeerForm((prev) => ({ ...prev, descriptionShort: e.target.value }))} />
              </label>

              <label className="mt-4 block text-sm">
                <span className="mb-1 block font-medium">Tasting Notes (comma-separated)</span>
                <input className={fieldClass} value={beerTastingNotesInput} onChange={(e) => setBeerTastingNotesInput(e.target.value)} />
              </label>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Card Image Path</span>
                  <input className={fieldClass} value={beerForm.images.cardPath} onChange={(e) => setBeerForm((prev) => ({ ...prev, images: { ...prev.images, cardPath: e.target.value } }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Hero Image Path</span>
                  <input className={fieldClass} value={beerForm.images.heroPath} onChange={(e) => setBeerForm((prev) => ({ ...prev, images: { ...prev.images, heroPath: e.target.value } }))} />
                </label>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Upload Card Image</span>
                  <input type="file" accept="image/*" onChange={(e) => onUploadBeerImage("card", e.target.files?.[0] ?? null, beerForm.slug)} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Upload Hero Image</span>
                  <input type="file" accept="image/*" onChange={(e) => onUploadBeerImage("hero", e.target.files?.[0] ?? null, beerForm.slug)} />
                </label>
              </div>

              <div className="mt-4 flex items-center gap-3">
                <Button onClick={onSaveBeer} disabled={isSaving}>Save Beer</Button>
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
                  aria-label="New venue record"
                  onClick={() => {
                    onNewVenue();
                    document.getElementById("venue-name")?.focus();
                  }}
                >
                  New
                </Button>
              </div>
              <ul className="space-y-1">
                {venues.map((venue) => (
                  <li key={venue.slug}>
                    <button
                      type="button"
                      aria-current={selectedVenueSlug === venue.slug}
                      onClick={() => onSelectVenue(venue.slug)}
                      className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${
                        selectedVenueSlug === venue.slug ? "bg-stone/40" : "hover:bg-stone/20"
                      }`}
                    >
                      {venue.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-lg border border-stone bg-paper p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">
                    Name
                    <span aria-hidden="true" className="text-ember"> *</span>
                  </span>
                  <input id="venue-name" required className={fieldClass} value={venueForm.name} onChange={(e) => setVenueForm((prev) => ({ ...prev, name: e.target.value }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">
                    Slug
                    <span aria-hidden="true" className="text-ember"> *</span>
                  </span>
                  <input required className={fieldClass} value={venueForm.slug} onChange={(e) => setVenueForm((prev) => ({ ...prev, slug: e.target.value.trim().toLowerCase() }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Type</span>
                  <select className={fieldClass} value={venueForm.type} onChange={(e) => setVenueForm((prev) => ({ ...prev, type: e.target.value as Venue["type"] }))}>
                    <option value="bar_restaurant">Bar / Restaurant</option>
                    <option value="retail">Retail</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Location Name</span>
                  <input className={fieldClass} value={venueForm.locationName} onChange={(e) => setVenueForm((prev) => ({ ...prev, locationName: e.target.value }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Sort Order</span>
                  <input type="number" className={fieldClass} value={venueForm.sortOrder} onChange={(e) => setVenueForm((prev) => ({ ...prev, sortOrder: Number(e.target.value) }))} />
                </label>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-3">
                <details className="text-sm">
                  <summary className="cursor-pointer rounded-md border border-ink/50 px-3 py-2 font-medium">
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
                  <summary className="cursor-pointer rounded-md border border-ink/50 px-3 py-2 font-medium">
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
                  <summary className="cursor-pointer rounded-md border border-ink/50 px-3 py-2 font-medium">
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
                  <input className={fieldClass} value={venueForm.links.website ?? ""} onChange={(e) => setVenueForm((prev) => ({ ...prev, links: { ...prev.links, website: e.target.value } }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Maps Link</span>
                  <input className={fieldClass} value={venueForm.links.maps ?? ""} onChange={(e) => setVenueForm((prev) => ({ ...prev, links: { ...prev.links, maps: e.target.value } }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Instagram</span>
                  <input className={fieldClass} value={venueForm.links.instagram ?? ""} onChange={(e) => setVenueForm((prev) => ({ ...prev, links: { ...prev.links, instagram: e.target.value } }))} />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Facebook</span>
                  <input className={fieldClass} value={venueForm.links.facebook ?? ""} onChange={(e) => setVenueForm((prev) => ({ ...prev, links: { ...prev.links, facebook: e.target.value } }))} />
                </label>
              </div>

              <label className="mt-4 block text-sm">
                <span className="mb-1 block font-medium">Public Notes</span>
                <textarea className={fieldClass} rows={3} value={venueForm.notesPublic ?? ""} onChange={(e) => setVenueForm((prev) => ({ ...prev, notesPublic: e.target.value }))} />
              </label>

              <div className="mt-4 flex items-center gap-3">
                <Button onClick={onSaveVenue} disabled={isSaving}>Save Venue</Button>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" checked={venueForm.isPublic} onChange={(e) => setVenueForm((prev) => ({ ...prev, isPublic: e.target.checked }))} />
                  Public
                </label>
              </div>
            </div>
          </div>
        </TabsContent>

        {isSuperAdmin && (
          <TabsContent value="access">
            <AdminAccessPanel user={accessUser} onStatusMessage={onStatusMessage} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
