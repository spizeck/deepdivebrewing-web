import type { Beer } from "@/lib/types";

// Deterministic fixture records for the test-only /carousel-fixture route
// used by the Playwright carousel suite. Six slides mirror the homepage's
// featured slice (beers.slice(0, 6)) so pointer/keyboard/drag coverage runs
// against the real BeerCarousel even when the Firestore catalog is empty in
// CI. Not real business data — names are placeholders.
export const CAROUSEL_FIXTURE_BEERS: Beer[] = [
  "Suds Ridge Pale",
  "Fort Bay Porter",
  "Ladder Bay Lager",
  "Windward Wit",
  "Cove Side Stout",
  "Spring Bay Saison",
].map((name, i) => ({
  name,
  slug: name.toLowerCase().replace(/\s+/g, "-"),
  style: "Fixture Ale",
  abv: 4 + i * 0.5,
  ibu: 20 + i * 5,
  srm: 5 + i,
  status: "core",
  descriptionShort: `Fixture beer ${i + 1}.`,
  tastingNotes: [],
  images: { cardPath: "", heroPath: "" },
  isPublic: true,
  sortOrder: i + 1,
}));

// Every card shares one real static asset so next/image resolves a real
// same-origin file (an empty cardPath would build a Firebase URL that the
// smoke suite's cross-origin aborts would leave broken).
export const CAROUSEL_FIXTURE_IMAGE = "/photos/og-default.jpg";
