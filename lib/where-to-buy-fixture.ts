import type { Beer, Venue } from "@/lib/types";

// Deterministic fixture records for the test-only /where-to-buy-fixture
// route used by the Playwright filtering suite. Shapes match the real
// Firestore models so VenueDirectory exercises the same code path as the
// production page. The three Saba venues deliberately use different
// locality strings ("<locality>, Saba") so the suite covers the island
// grouping regression from issue #116. Not real business data —
// names/links are placeholders.
export const WHERE_TO_BUY_FIXTURE_BEERS: Beer[] = [
  {
    name: "Saba Suds Pilsner",
    slug: "saba-suds-pilsner",
    style: "Pilsner",
    abv: 4.8,
    ibu: 28,
    srm: 4,
    status: "core",
    descriptionShort: "Fixture pilsner.",
    tastingNotes: [],
    images: { cardPath: "", heroPath: "" },
    isPublic: true,
    sortOrder: 1,
  },
  {
    name: "Fort Bay IPA",
    slug: "fort-bay-ipa",
    style: "IPA",
    abv: 6.2,
    ibu: 55,
    srm: 8,
    status: "core",
    descriptionShort: "Fixture IPA.",
    tastingNotes: [],
    images: { cardPath: "", heroPath: "" },
    isPublic: true,
    sortOrder: 2,
  },
  {
    // Public but carried by no fixture venue — must not appear as a filter
    // option.
    name: "Flat Point Amber",
    slug: "flat-point-amber",
    style: "Amber Ale",
    abv: 5.4,
    ibu: 32,
    srm: 12,
    status: "seasonal",
    descriptionShort: "Fixture amber.",
    tastingNotes: [],
    images: { cardPath: "", heroPath: "" },
    isPublic: true,
    sortOrder: 3,
  },
];

export const WHERE_TO_BUY_FIXTURE_VENUES: Venue[] = [
  {
    name: "Fixture Tavern",
    slug: "fixture-tavern",
    type: "bar_restaurant",
    locationName: "Fort Bay, Saba",
    carriesBeerSlugs: ["saba-suds-pilsner", "fort-bay-ipa"],
    tapBeerSlugs: ["saba-suds-pilsner"],
    canBeerSlugs: ["fort-bay-ipa"],
    isPublic: true,
    sortOrder: 1,
    links: {
      website: "https://example.com/tavern",
      maps: "https://maps.example.com/fixture-tavern",
    },
  },
  {
    name: "Fixture Bottle Shop",
    slug: "fixture-bottle-shop",
    type: "retail",
    locationName: "Windwardside, Saba",
    carriesBeerSlugs: ["fort-bay-ipa"],
    tapBeerSlugs: [],
    canBeerSlugs: ["fort-bay-ipa"],
    isPublic: true,
    sortOrder: 2,
    links: {
      website: "https://example.com/bottle-shop",
    },
  },
  {
    name: "Fixture Harbor Bar",
    slug: "fixture-harbor-bar",
    type: "bar_restaurant",
    locationName: "SXM",
    carriesBeerSlugs: ["saba-suds-pilsner", "fort-bay-ipa"],
    tapBeerSlugs: ["saba-suds-pilsner", "fort-bay-ipa"],
    canBeerSlugs: [],
    isPublic: true,
    sortOrder: 3,
    links: {},
  },
  {
    name: "Fixture Quiet Cafe",
    slug: "fixture-quiet-cafe",
    type: "bar_restaurant",
    locationName: "Windwardside / The Bottom, Saba",
    carriesBeerSlugs: ["saba-suds-pilsner"],
    tapBeerSlugs: ["saba-suds-pilsner"],
    canBeerSlugs: [],
    isPublic: true,
    sortOrder: 4,
    links: {},
  },
  {
    // Island Flavor-style regression venue (Issue #130): valid
    // name/location/type and directions + social links, but no beer under
    // either format. Must never render publicly — and as the only venue on
    // Statia it must not create an island group or filter option either.
    name: "Fixture Empty Cantina",
    slug: "fixture-empty-cantina",
    type: "bar_restaurant",
    locationName: "Oranjestad, Statia",
    carriesBeerSlugs: [],
    tapBeerSlugs: [],
    canBeerSlugs: [],
    isPublic: true,
    sortOrder: 5,
    links: {
      website: "https://example.com/empty-cantina",
      maps: "https://maps.example.com/empty-cantina",
      instagram: "https://instagram.com/emptycantina",
    },
  },
];
