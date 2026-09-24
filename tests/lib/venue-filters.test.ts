import { describe, it } from "node:test";
import assert from "node:assert";
import {
  carriedBeerOptions,
  distinctIslands,
  filterVenues,
  groupVenuesByIsland,
  hasActiveVenueFilters,
  hasAnyFormatData,
  islandDisplayName,
  islandKey,
  parseVenueFilters,
  resolveVenueIsland,
  sanitizeVenueFilters,
  venueCardLocation,
  venueCarriesBeer,
  venueFiltersToSearch,
  venueIslandKey,
  venueIsStocked,
  venueOffersFormat,
  EMPTY_VENUE_FILTERS,
} from "../../lib/venue-filters";
import {
  WHERE_TO_BUY_FIXTURE_BEERS,
  WHERE_TO_BUY_FIXTURE_VENUES,
} from "../../lib/where-to-buy-fixture";
import type { Beer, Venue } from "../../lib/types";

function venue(overrides: Partial<Venue>): Venue {
  return {
    name: "Venue",
    slug: "venue",
    type: "bar_restaurant",
    locationName: "Saba",
    carriesBeerSlugs: [],
    isPublic: true,
    sortOrder: 0,
    links: {},
    ...overrides,
  };
}

function beer(overrides: Partial<Beer>): Beer {
  return {
    name: "Beer",
    slug: "beer",
    style: "Style",
    abv: 5,
    ibu: null,
    srm: null,
    status: "core",
    descriptionShort: "",
    tastingNotes: [],
    images: { cardPath: "", heroPath: "" },
    isPublic: true,
    sortOrder: 0,
    ...overrides,
  };
}

describe("islandKey / islandDisplayName", () => {
  it("normalizes SXM spelling variants to one canonical key", () => {
    assert.equal(islandKey("SXM"), "sxm");
    assert.equal(islandKey("Sint Maarten"), "sxm");
    assert.equal(islandKey("saint martin"), "sxm");
  });

  it("normalizes Statia variants", () => {
    assert.equal(islandKey("Statia"), "statia");
    assert.equal(islandKey("Sint Eustatius"), "statia");
  });

  it("normalizes every Saba locality variant to the one saba key", () => {
    // Issue #116: Fort Bay / Windwardside / The Bottom are localities on
    // Saba, not separate islands. The canonical form is "<locality>,
    // Saba" — the island is the final comma-separated segment.
    for (const locationName of [
      "Saba",
      "Fort Bay, Saba",
      "Windwardside, Saba",
      "The Bottom, Saba",
      "Windwardside / The Bottom, Saba",
      "  the bottom ,  saba ",
    ]) {
      assert.equal(islandKey(locationName), "saba", locationName);
    }
  });

  it("does not misclassify values that merely contain the saba substring", () => {
    assert.notEqual(islandKey("Sabana Grande"), "saba");
  });

  it("defaults empty location to saba, matching the public page", () => {
    assert.equal(islandKey(""), "saba");
    assert.equal(islandKey(undefined), "saba");
  });

  it("keeps other location names as lowercase keys", () => {
    assert.equal(islandKey("Saba"), "saba");
    assert.equal(islandKey("Bonaire"), "bonaire");
  });

  it("renders intentional display names for known islands", () => {
    const sxmLabel = islandDisplayName("sxm");
    assert.equal(sxmLabel, "Sint Maarten / Saint Martin");
    // The two jurisdictions are the whole label — "SXM" is the internal
    // canonical key and must not be appended as a third island name.
    assert.equal(sxmLabel.includes("SXM"), false);
    assert.equal(islandDisplayName("statia"), "Sint Eustatius / Statia");
    assert.equal(islandDisplayName("saba"), "Saba");
    // A Saba locality can never surface as a heading again.
    assert.equal(islandDisplayName(islandKey("Fort Bay, Saba")), "Saba");
    assert.equal(
      islandDisplayName(islandKey("Windwardside / The Bottom, Saba")),
      "Saba"
    );
  });

  it("title-cases unknown future islands word by word", () => {
    assert.equal(islandDisplayName("bonaire"), "Bonaire");
    assert.equal(islandDisplayName("st. barths"), "St. Barths");
  });

  it("treats Object.prototype-named keys as unknown islands", () => {
    // A plain-object label lookup would return inherited members like
    // `constructor` instead of a string.
    for (const key of ["constructor", "toString", "__proto__"]) {
      assert.equal(typeof islandDisplayName(key), "string", key);
    }
    assert.equal(islandDisplayName("constructor"), "Constructor");
  });
});

describe("venueIslandKey (canonical field, Issue #134)", () => {
  it("prefers the stored island over parsing locationName", () => {
    // The locality must never determine grouping: "Philipsburg" parses to
    // a non-island key, but the canonical field says sxm.
    assert.equal(
      venueIslandKey(venue({ island: "sxm", locationName: "Philipsburg" })),
      "sxm"
    );
    assert.equal(
      venueIslandKey(venue({ island: "saba", locationName: "Windwardside" })),
      "saba"
    );
    // Even a locationName that would parse to a different island loses.
    assert.equal(
      venueIslandKey(venue({ island: "statia", locationName: "Saba" })),
      "statia"
    );
  });

  it("falls back to legacy locationName inference when island is absent", () => {
    assert.equal(
      venueIslandKey(venue({ locationName: "Windwardside, Saba" })),
      "saba"
    );
    assert.equal(venueIslandKey(venue({ locationName: "SXM" })), "sxm");
  });

  it("ignores invalid stored island values", () => {
    // A non-canonical stored value behaves as if the field were absent.
    const legacy = venue({ locationName: "Fort Bay, Saba" });
    assert.equal(
      venueIslandKey({ ...legacy, island: "philipsburg" as never }),
      "saba"
    );
  });
});

describe("resolveVenueIsland (admin editor preselection)", () => {
  it("returns the stored island when valid", () => {
    assert.equal(
      resolveVenueIsland(venue({ island: "sxm", locationName: "anything" })),
      "sxm"
    );
  });

  it("derives the island from legacy locationName when unambiguous", () => {
    assert.equal(
      resolveVenueIsland(venue({ locationName: "Windwardside, Saba" })),
      "saba"
    );
    assert.equal(resolveVenueIsland(venue({ locationName: "SXM" })), "sxm");
    assert.equal(
      resolveVenueIsland(venue({ locationName: "Oranjestad, Statia" })),
      "statia"
    );
  });

  it("returns undefined for a bare locality rather than guessing", () => {
    assert.equal(
      resolveVenueIsland(venue({ locationName: "Philipsburg" })),
      undefined
    );
    assert.equal(
      resolveVenueIsland(venue({ locationName: "Bonaire" })),
      undefined
    );
  });
});

describe("venueCardLocation", () => {
  it("composes locality + short island label for migrated venues", () => {
    assert.equal(
      venueCardLocation(venue({ island: "saba", locationName: "Windwardside" })),
      "Windwardside, Saba"
    );
    assert.equal(
      venueCardLocation(venue({ island: "saba", locationName: "Fort Bay" })),
      "Fort Bay, Saba"
    );
    // Jurisdiction-aware: the dual-label is wrong as a locality address.
    assert.equal(
      venueCardLocation(venue({ island: "sxm", locationName: "Philipsburg" })),
      "Philipsburg, Sint Maarten"
    );
    assert.equal(
      venueCardLocation(venue({ island: "statia", locationName: "Oranjestad" })),
      "Oranjestad, Statia"
    );
  });

  it("shows only the whole-island label when locality is blank or redundant", () => {
    assert.equal(
      venueCardLocation(venue({ island: "saba", locationName: "" })),
      "Saba"
    );
    assert.equal(
      venueCardLocation(venue({ island: "saba", locationName: "Saba" })),
      "Saba"
    );
    assert.equal(
      venueCardLocation(venue({ island: "sxm", locationName: "" })),
      "Sint Maarten / Saint Martin"
    );
  });

  it("does not double the island when locality already ends with it", () => {
    // Admin typed the old combined format into the locality field — the card
    // shows it as-is instead of "Windwardside, Saba, Saba".
    assert.equal(
      venueCardLocation(
        venue({ island: "saba", locationName: "Windwardside, Saba" })
      ),
      "Windwardside, Saba"
    );
    assert.equal(
      venueCardLocation(
        venue({ island: "sxm", locationName: "Philipsburg, Sint Maarten" })
      ),
      "Philipsburg, Sint Maarten"
    );
  });

  it("shows the raw locationName for legacy records without island", () => {
    assert.equal(
      venueCardLocation(venue({ locationName: "Windwardside, Saba" })),
      "Windwardside, Saba"
    );
    assert.equal(
      venueCardLocation(venue({ locationName: "SXM" })),
      "SXM"
    );
  });
});

describe("venueCarriesBeer / venueOffersFormat", () => {
  const v = venue({
    carriesBeerSlugs: ["pilsner"],
    tapBeerSlugs: ["pilsner"],
    canBeerSlugs: ["ipa"],
  });

  it("matches beers recorded under any of the three slug lists", () => {
    assert.equal(venueCarriesBeer(v, "pilsner"), true);
    assert.equal(venueCarriesBeer(v, "ipa"), true); // in canBeerSlugs only
    assert.equal(venueCarriesBeer(v, "amber"), false);
  });

  it("handles missing optional arrays", () => {
    const bare = venue({ carriesBeerSlugs: ["pilsner"] });
    assert.equal(venueCarriesBeer(bare, "pilsner"), true);
    assert.equal(venueOffersFormat(bare, "tap", null), false);
  });

  it("format check with a beer means that beer in that format", () => {
    assert.equal(venueOffersFormat(v, "tap", "pilsner"), true);
    assert.equal(venueOffersFormat(v, "tap", "ipa"), false);
    assert.equal(venueOffersFormat(v, "can", "ipa"), true);
  });

  it("format check without a beer means any beer in that format", () => {
    assert.equal(venueOffersFormat(v, "tap", null), true);
    assert.equal(venueOffersFormat(v, "can", null), true);
    assert.equal(
      venueOffersFormat(venue({ carriesBeerSlugs: ["x"] }), "tap", null),
      false
    );
  });
});

describe("filterVenues", () => {
  // Tavern:      island saba, locality Fort Bay — pilsner on tap + ipa in can
  // Bottle Shop: island saba, locality Windwardside — ipa in can
  // Harbor Bar:  island sxm, locality Philipsburg — pilsner + ipa on tap
  // Quiet Cafe:  LEGACY record — no island; locationName "Windwardside /
  //              The Bottom, Saba" — pilsner on tap
  // (Empty Cantina — Statia, no beer — is excluded up front by
  // venueIsStocked, mirroring the page layer; see the describe below.)
  const venues = WHERE_TO_BUY_FIXTURE_VENUES.filter(venueIsStocked);
  const names = (list: Venue[]) => list.map((v) => v.slug);

  it("no filters returns all public venues in order", () => {
    assert.deepEqual(names(filterVenues(venues, EMPTY_VENUE_FILTERS)), [
      "fixture-tavern",
      "fixture-bottle-shop",
      "fixture-harbor-bar",
      "fixture-quiet-cafe",
    ]);
  });

  it("beer only returns venues carrying it in any format", () => {
    assert.deepEqual(
      names(
        filterVenues(venues, { ...EMPTY_VENUE_FILTERS, beer: "saba-suds-pilsner" })
      ),
      ["fixture-tavern", "fixture-harbor-bar", "fixture-quiet-cafe"]
    );
  });

  it("beer + tap returns only venues where that beer is on tap", () => {
    assert.deepEqual(
      names(
        filterVenues(venues, {
          beer: "fort-bay-ipa",
          format: "tap",
          island: null,
        })
      ),
      ["fixture-harbor-bar"]
    );
  });

  it("beer + can returns only venues where that beer is in can", () => {
    assert.deepEqual(
      names(
        filterVenues(venues, {
          beer: "saba-suds-pilsner",
          format: "can",
          island: null,
        })
      ),
      []
    );
  });

  it("format-only filtering checks any beer in that format", () => {
    assert.deepEqual(
      names(filterVenues(venues, { ...EMPTY_VENUE_FILTERS, format: "tap" })),
      ["fixture-tavern", "fixture-harbor-bar", "fixture-quiet-cafe"]
    );
    assert.deepEqual(
      names(filterVenues(venues, { ...EMPTY_VENUE_FILTERS, format: "can" })),
      ["fixture-tavern", "fixture-bottle-shop"]
    );
  });

  it("island filter uses the canonical island field, not the locality", () => {
    // Harbor Bar's locality is "Philipsburg" — the island=sxm filter must
    // match it via the canonical field, and "philipsburg" is not a filter.
    assert.deepEqual(
      names(filterVenues(venues, { ...EMPTY_VENUE_FILTERS, island: "sxm" })),
      ["fixture-harbor-bar"]
    );
    assert.deepEqual(
      names(
        filterVenues(venues, { ...EMPTY_VENUE_FILTERS, island: "philipsburg" })
      ),
      []
    );
  });

  it("island saba returns every Saba venue regardless of locality", () => {
    // The three fixture Saba venues use different "<locality>, Saba"
    // locationNames — one canonical key must catch them all (#116).
    assert.deepEqual(
      names(filterVenues(venues, { ...EMPTY_VENUE_FILTERS, island: "saba" })),
      ["fixture-tavern", "fixture-bottle-shop", "fixture-quiet-cafe"]
    );
  });

  it("categories combine with AND", () => {
    assert.deepEqual(
      names(
        filterVenues(venues, {
          beer: "saba-suds-pilsner",
          format: null,
          island: "saba",
        })
      ),
      ["fixture-tavern", "fixture-quiet-cafe"]
    );
    assert.deepEqual(
      names(
        filterVenues(venues, {
          beer: "fort-bay-ipa",
          format: "can",
          island: "saba",
        })
      ),
      ["fixture-tavern", "fixture-bottle-shop"]
    );
  });

  it("impossible combinations produce an empty result, not an error", () => {
    assert.deepEqual(
      filterVenues(venues, {
        beer: "fort-bay-ipa",
        format: "can",
        island: "sxm",
      }),
      []
    );
  });
});

describe("distinctIslands / groupVenuesByIsland", () => {
  it("collapses spelling variants into one island", () => {
    const venues = [
      venue({ slug: "a", locationName: "SXM" }),
      venue({ slug: "b", locationName: "Sint Maarten" }),
      venue({ slug: "c", locationName: "Saba" }),
    ];
    assert.deepEqual(distinctIslands(venues), ["saba", "sxm"]);
    const groups = groupVenuesByIsland(venues);
    assert.deepEqual(
      groups.map((g) => g.key),
      ["saba", "sxm"]
    );
    assert.deepEqual(
      groups[1].venues.map((v) => v.slug),
      ["a", "b"]
    );
  });

  it("offers one saba option and one saba group for all Saba localities", () => {
    // Issue #116 regression: distinct "<locality>, Saba" locationNames
    // must not fragment into per-locality island options or headings.
    // Stocked filter mirrors the public page (Empty Cantina drops out).
    const venues = WHERE_TO_BUY_FIXTURE_VENUES.filter(venueIsStocked);
    assert.deepEqual(distinctIslands(venues), ["saba", "sxm"]);
    const groups = groupVenuesByIsland(venues);
    assert.deepEqual(
      groups.map((g) => g.key),
      ["saba", "sxm"]
    );
    assert.deepEqual(
      groups[0].venues.map((v) => v.slug),
      ["fixture-tavern", "fixture-bottle-shop", "fixture-quiet-cafe"]
    );
  });

  it("a locality can never become an island option or group (Issue #134)", () => {
    // Harbor Bar's locationName is now a pure locality ("Philipsburg") with
    // island "sxm" — neither the option list nor the headings may contain it.
    const venues = WHERE_TO_BUY_FIXTURE_VENUES.filter(venueIsStocked);
    const islands = distinctIslands(venues);
    assert.equal(islands.includes("philipsburg"), false);
    assert.equal(islands.includes("windwardside"), false);
    assert.equal(islands.includes("fort bay"), false);
    assert.deepEqual(islands, ["saba", "sxm"]);
    assert.deepEqual(
      groupVenuesByIsland(venues).map((g) => g.key),
      ["saba", "sxm"]
    );
  });
});

describe("carriedBeerOptions", () => {
  it("only offers public beers carried by at least one listed venue", () => {
    const options = carriedBeerOptions(
      WHERE_TO_BUY_FIXTURE_VENUES,
      WHERE_TO_BUY_FIXTURE_BEERS
    );
    assert.deepEqual(
      options.map((o) => o.slug),
      ["saba-suds-pilsner", "fort-bay-ipa"]
    );
    // flat-point-amber is public but carried nowhere — not an option.
  });

  it("excludes non-public beers even when a venue references them", () => {
    const beers = [
      beer({ slug: "secret-brew", name: "Secret", isPublic: false }),
      beer({ slug: "pilsner", name: "Pilsner" }),
    ];
    const venues = [
      venue({ carriesBeerSlugs: ["secret-brew", "pilsner"] }),
    ];
    assert.deepEqual(
      carriedBeerOptions(venues, beers).map((o) => o.slug),
      ["pilsner"]
    );
  });

  it("includes beers referenced only via tap/can lists", () => {
    const beers = [beer({ slug: "ipa", name: "IPA" })];
    const venues = [venue({ canBeerSlugs: ["ipa"] })];
    assert.deepEqual(
      carriedBeerOptions(venues, beers).map((o) => o.slug),
      ["ipa"]
    );
  });
});

describe("venueIsStocked", () => {
  it("is true for On Tap only, In Can only, and both", () => {
    assert.equal(venueIsStocked(venue({ tapBeerSlugs: ["ipa"] })), true);
    assert.equal(venueIsStocked(venue({ canBeerSlugs: ["ipa"] })), true);
    assert.equal(
      venueIsStocked(venue({ tapBeerSlugs: ["ipa"], canBeerSlugs: ["x"] })),
      true
    );
  });

  it("is false when neither format lists a beer", () => {
    assert.equal(venueIsStocked(venue({})), false);
    assert.equal(
      venueIsStocked(venue({ tapBeerSlugs: [], canBeerSlugs: [] })),
      false
    );
    // A beer recorded only under carriesBeerSlugs produces no visible
    // On Tap / In Can line, so it does not count as stocked.
    assert.equal(
      venueIsStocked(venue({ carriesBeerSlugs: ["ipa"] })),
      false
    );
  });

  it("removes unstocked venues from islands, beer options, and counts", () => {
    // Mirrors the page wiring: the stocked list feeds every downstream
    // derivation, so the sole unstocked Statia venue contributes nothing.
    const stocked = WHERE_TO_BUY_FIXTURE_VENUES.filter(venueIsStocked);
    assert.equal(stocked.length, 4);
    assert.deepEqual(distinctIslands(stocked), ["saba", "sxm"]);
    assert.deepEqual(
      groupVenuesByIsland(stocked).map((g) => g.key),
      ["saba", "sxm"]
    );
    assert.deepEqual(
      carriedBeerOptions(stocked, WHERE_TO_BUY_FIXTURE_BEERS).map(
        (o) => o.slug
      ),
      ["saba-suds-pilsner", "fort-bay-ipa"]
    );
  });
});

describe("hasAnyFormatData", () => {
  it("is false when no venue lists formats, true otherwise", () => {
    assert.equal(hasAnyFormatData([venue({})]), false);
    assert.equal(
      hasAnyFormatData([venue({ tapBeerSlugs: ["x"] })]),
      true
    );
  });
});

describe("URL state: parseVenueFilters / venueFiltersToSearch", () => {
  it("parses beer, format, and island params", () => {
    assert.deepEqual(
      parseVenueFilters("?beer=american-amber&format=tap&island=saba"),
      { beer: "american-amber", format: "tap", island: "saba" }
    );
  });

  it("empty query yields empty filters", () => {
    assert.deepEqual(parseVenueFilters(""), EMPTY_VENUE_FILTERS);
    assert.deepEqual(parseVenueFilters("?"), EMPTY_VENUE_FILTERS);
  });

  it("drops unknown format values and blank params", () => {
    assert.deepEqual(
      parseVenueFilters("?format=keg&beer=&island=%20"),
      { beer: null, format: null, island: null }
    );
  });

  it("serializes back to a stable query string", () => {
    assert.equal(
      venueFiltersToSearch({ beer: "ipa", format: "can", island: "sxm" }),
      "?beer=ipa&format=can&island=sxm"
    );
    assert.equal(venueFiltersToSearch(EMPTY_VENUE_FILTERS), "");
  });
});

describe("sanitizeVenueFilters", () => {
  const allowed = {
    beerSlugs: new Set(["ipa", "pilsner"]),
    islands: new Set(["saba", "sxm"]),
  };

  it("keeps valid values", () => {
    assert.deepEqual(
      sanitizeVenueFilters(
        { beer: "ipa", format: "tap", island: "sxm" },
        allowed
      ),
      { beer: "ipa", format: "tap", island: "sxm" }
    );
  });

  it("drops stale beer slugs and unknown islands", () => {
    assert.deepEqual(
      sanitizeVenueFilters(
        { beer: "deleted-beer", format: "can", island: "aruba" },
        allowed
      ),
      { beer: null, format: "can", island: null }
    );
  });
});

describe("hasActiveVenueFilters", () => {
  it("reflects whether any facet is set", () => {
    assert.equal(hasActiveVenueFilters(EMPTY_VENUE_FILTERS), false);
    assert.equal(
      hasActiveVenueFilters({ ...EMPTY_VENUE_FILTERS, format: "tap" }),
      true
    );
  });
});
