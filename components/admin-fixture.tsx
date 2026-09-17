"use client";

// Deterministic rendering of the authenticated admin workspace for the
// Playwright accessibility suite. Rendered only by /admin-fixture, which is
// gated server-side by the ADMIN_A11Y_FIXTURE env var (set by the Playwright
// webServer config). It never touches Firebase: state is local fixture data
// and AdminAccessPanel's fetches are intercepted by Playwright route mocks.

import { useState } from "react";
import {
  AdminWorkspace,
  type RebuildMeta,
} from "@/components/admin-workspace";
import type { AdminRole, Beer, Venue } from "@/lib/types";

const FIXTURE_BEERS: Beer[] = [
  {
    name: "Saba Suds Pilsner",
    slug: "saba-suds-pilsner",
    style: "Pilsner",
    abv: 4.8,
    ibu: 28,
    srm: 4,
    status: "core",
    descriptionShort: "Crisp island pilsner.",
    tastingNotes: ["crisp", "floral"],
    images: { cardPath: "", heroPath: "" },
    isPublic: true,
    sortOrder: 1,
  },
  {
    name: "Mount Scenery Stout",
    slug: "mount-scenery-stout",
    style: "Stout",
    abv: 6.2,
    ibu: 40,
    srm: 35,
    status: "limited",
    descriptionShort: "Roasty, limited release.",
    tastingNotes: ["coffee", "cacao"],
    images: { cardPath: "", heroPath: "" },
    isPublic: false,
    sortOrder: 2,
  },
];

const FIXTURE_VENUES: Venue[] = [
  {
    name: "Fixture Tavern",
    slug: "fixture-tavern",
    type: "bar_restaurant",
    locationName: "Windwardside",
    carriesBeerSlugs: ["saba-suds-pilsner"],
    tapBeerSlugs: ["saba-suds-pilsner"],
    canBeerSlugs: [],
    isPublic: true,
    sortOrder: 1,
    links: { website: "https://example.com" },
    notesPublic: "Fixture venue notes.",
  },
];

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
  images: { cardPath: "", heroPath: "" },
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

function arrayToCsv(value?: string[]): string {
  return (value ?? []).join(", ");
}

export function AdminFixture({ role }: { role: AdminRole }) {
  const [statusMessage, setStatusMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isTriggeringRebuild, setIsTriggeringRebuild] = useState(false);
  const [rebuildCooldownUntil, setRebuildCooldownUntil] = useState(0);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);

  // Content "updated after last rebuild" so the warning banner + badge render
  // and axe checks them in place.
  const [rebuildMeta] = useState<RebuildMeta>({
    lastTriggeredAt: 1_700_000_000_000,
    lastTriggeredBy: "owner@example.com",
    contentUpdatedAt: 1_700_100_000_000,
    contentUpdatedBy: "editor@example.com",
    lastContentUpdateType: "beer",
  });

  const [selectedBeerSlug, setSelectedBeerSlug] = useState(FIXTURE_BEERS[0].slug);
  const [beerForm, setBeerForm] = useState<Beer>(FIXTURE_BEERS[0]);
  const [beerTastingNotesInput, setBeerTastingNotesInput] = useState(
    arrayToCsv(FIXTURE_BEERS[0].tastingNotes)
  );

  const [selectedVenueSlug, setSelectedVenueSlug] = useState(FIXTURE_VENUES[0].slug);
  const [venueForm, setVenueForm] = useState<Venue>(FIXTURE_VENUES[0]);
  const [venueCarriesSelection, setVenueCarriesSelection] = useState<string[]>(
    FIXTURE_VENUES[0].carriesBeerSlugs
  );
  const [venueTapSelection, setVenueTapSelection] = useState<string[]>(
    FIXTURE_VENUES[0].tapBeerSlugs ?? []
  );
  const [venueCanSelection, setVenueCanSelection] = useState<string[]>(
    FIXTURE_VENUES[0].canBeerSlugs ?? []
  );

  const rebuildCooldownMs = Math.max(0, rebuildCooldownUntil - currentTimeMs);

  function selectBeer(slug: string) {
    setSelectedBeerSlug(slug);
    const found = FIXTURE_BEERS.find((beer) => beer.slug === slug);
    if (found) {
      setBeerForm(found);
      setBeerTastingNotesInput(arrayToCsv(found.tastingNotes));
    }
  }

  function selectVenue(slug: string) {
    setSelectedVenueSlug(slug);
    const found = FIXTURE_VENUES.find((venue) => venue.slug === slug);
    if (found) {
      setVenueForm(found);
      setVenueCarriesSelection(found.carriesBeerSlugs ?? []);
      setVenueTapSelection(found.tapBeerSlugs ?? []);
      setVenueCanSelection(found.canBeerSlugs ?? []);
    }
  }

  function saveBeer() {
    if (!beerForm.slug || !beerForm.name) {
      setStatusMessage("Beer name and slug are required.");
      return;
    }
    setIsSaving(true);
    setStatusMessage("");
    // Mirrors the real handler's observable result without Firestore.
    setTimeout(() => {
      setStatusMessage("Beer saved.");
      setIsSaving(false);
    }, 50);
  }

  function saveVenue() {
    if (!venueForm.slug || !venueForm.name) {
      setStatusMessage("Venue name and slug are required.");
      return;
    }
    setIsSaving(true);
    setStatusMessage("");
    setTimeout(() => {
      setStatusMessage("Venue saved.");
      setIsSaving(false);
    }, 50);
  }

  function triggerRebuild() {
    setIsTriggeringRebuild(true);
    setStatusMessage("");
    setTimeout(() => {
      setStatusMessage("Rebuild triggered.");
      setIsTriggeringRebuild(false);
      setRebuildCooldownUntil(Date.now() + 60_000);
      setCurrentTimeMs(Date.now());
    }, 50);
  }

  return (
    <AdminWorkspace
      userEmail="fixture-admin@example.com"
      isSuperAdmin={role === "superadmin"}
      accessUser={{ getIdToken: async () => "fixture-token" }}
      onSignOut={() => setStatusMessage("Signed out.")}
      statusMessage={statusMessage}
      onStatusMessage={setStatusMessage}
      isTriggeringRebuild={isTriggeringRebuild}
      rebuildCooldownMs={rebuildCooldownMs}
      isRebuildDisabled={isTriggeringRebuild || rebuildCooldownMs > 0}
      onTriggerRebuild={triggerRebuild}
      rebuildMeta={rebuildMeta}
      hasUpdatesSinceLastRebuild={true}
      beers={FIXTURE_BEERS}
      selectedBeerSlug={selectedBeerSlug}
      onSelectBeer={selectBeer}
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
      onUploadBeerImage={(kind, file) => {
        if (file) {
          setStatusMessage(
            `${kind === "card" ? "Card" : "Hero"} image uploaded. Save beer to persist.`
          );
        }
      }}
      venues={FIXTURE_VENUES}
      selectedVenueSlug={selectedVenueSlug}
      onSelectVenue={selectVenue}
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
