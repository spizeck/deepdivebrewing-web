import type { Beer, Venue } from "@/lib/types";
import {
  isVenueIsland,
  VENUE_ISLAND_CARD_LABELS,
  VENUE_ISLAND_LABELS,
  type VenueIsland,
} from "@/lib/venue-islands";

// Pure filtering/grouping logic for the /where-to-buy venue directory.
// Firebase-free: this module is imported by a client component, so it must
// never pull in the Firebase client SDK (see docs/operations/performance.md).
//
// Data model recap (see docs/TECHNICAL.md `venues`):
// - `carriesBeerSlugs[]` — every beer the venue carries in any format
// - `tapBeerSlugs[]` — beers currently marked On Tap
// - `canBeerSlugs[]` — beers currently marked In Can
// - `island` — canonical island key ("saba" | "sxm" | "statia"); drives all
//   public grouping/filtering (Issue #134)
// - `locationName` — free-text locality for card display only; on legacy
//   records it still encodes the island, so reads fall back to parsing it
//   (transitional — see `venueIslandKey`)
// These fields describe a venue listing, not live inventory; nothing here
// should be read as real-time stock or guaranteed availability.

// Package/serving states a venue can list a beer under, matching the admin
// venue editor's "On Tap" / "In Can" selections.
export type VenueFormat = "tap" | "can";

export interface VenueFilters {
  // Beer slug, format, or canonical island key — null means "any".
  beer: string | null;
  format: VenueFormat | null;
  island: string | null;
}

export const EMPTY_VENUE_FILTERS: VenueFilters = {
  beer: null,
  format: null,
  island: null,
};

export interface BeerOption {
  slug: string;
  name: string;
}

/**
 * True when the venue lists the beer in any capacity. `carriesBeerSlugs` is
 * the declared "in any format" list, but tap/can memberships also count —
 * the admin editor does not strictly force the subset invariant, so matching
 * is deliberately generous rather than silently dropping a venue whose beer
 * is only recorded under a format.
 */
export function venueCarriesBeer(venue: Venue, beerSlug: string): boolean {
  return (
    (venue.carriesBeerSlugs ?? []).includes(beerSlug) ||
    (venue.tapBeerSlugs ?? []).includes(beerSlug) ||
    (venue.canBeerSlugs ?? []).includes(beerSlug)
  );
}

/**
 * True when the venue offers the given format — for a specific beer when
 * `beerSlug` is set ("this beer On Tap"), otherwise when it lists any beer
 * under that format at all.
 */
export function venueOffersFormat(
  venue: Venue,
  format: VenueFormat,
  beerSlug: string | null
): boolean {
  const slugs =
    format === "tap" ? (venue.tapBeerSlugs ?? []) : (venue.canBeerSlugs ?? []);
  return beerSlug === null ? slugs.length > 0 : slugs.includes(beerSlug);
}

/**
 * Legacy island inference from a `locationName`. "sxm"/maarten/martin
 * collapse to "sxm", statia/eustatius to "statia", and "saba" plus Saba
 * localities written "<locality>, Saba" ("Fort Bay, Saba", "Windwardside /
 * The Bottom, Saba") collapse to "saba"; anything else lowercases as-is. An
 * empty/missing location follows the same Saba default the public page has
 * always used.
 *
 * Transitional (Issue #134): only used for records that predate the
 * canonical `island` field — `venueIslandKey` is the entry point for venue
 * records. Do not remove until every stored venue carries `island`.
 */
export function islandKey(locationName: string | undefined): string {
  const normalized = (locationName ?? "").trim().toLowerCase();
  if (
    normalized === "sxm" ||
    normalized.includes("maarten") ||
    normalized.includes("martin")
  ) {
    return "sxm";
  }
  if (normalized.includes("statia") || normalized.includes("eustatius")) {
    return "statia";
  }
  // Saba venues may prefix the island with a locality; the island is the
  // final comma-separated segment. Matching the whole segment — not a
  // bare "saba" substring — keeps unrelated names from being
  // misclassified.
  if (normalized.split(",").pop()?.trim() === "saba") {
    return "saba";
  }
  return normalized === "" ? "saba" : normalized;
}

/**
 * Canonical island key for a venue: the stored `island` field when present,
 * falling back to legacy `locationName` inference for records written before
 * Issue #134. New writes always set `island`, so grouping no longer depends
 * on parsing locality text — the fallback exists only until migration
 * completes.
 */
export function venueIslandKey(venue: Venue): string {
  return isVenueIsland(venue.island)
    ? venue.island
    : islandKey(venue.locationName);
}

/**
 * Island value for the admin venue editor: the stored canonical `island`,
 * or the legacy `locationName` inference when it resolves to a known island
 * so existing records preselect correctly. Returns undefined when the
 * locality text is not a recognizable island (e.g. a bare "Philipsburg") —
 * the editor then leaves the required select unset rather than guessing.
 */
export function resolveVenueIsland(venue: Venue): VenueIsland | undefined {
  if (isVenueIsland(venue.island)) return venue.island;
  const legacy = islandKey(venue.locationName);
  return isVenueIsland(legacy) ? legacy : undefined;
}

/**
 * Known-locality → island map for the venue migration (Issue #134). Only
 * entries that are unambiguous within the brewery's operating region belong
 * here — a bare locality string can never reach this map through inference.
 * "Oranjestad" is deliberately absent: it is also the capital of Aruba, so a
 * bare "Oranjestad" record stays unresolved and is reported for owner review
 * rather than guessed.
 */
const KNOWN_LOCALITY_ISLANDS: ReadonlyMap<string, VenueIsland> = new Map([
  ["windwardside", "saba"],
  ["the bottom", "saba"],
  ["fort bay", "saba"],
  ["philipsburg", "sxm"],
]);

export interface VenueGeography {
  island: VenueIsland;
  locality: string;
}

/**
 * Split a legacy `locationName` into canonical `{ island, locality }` for
 * the Issue #134 backfill. "<locality>, <island>" forms keep their locality
 * prefix; a bare island name ("Saba", "SXM", "Sint Maarten") yields an empty
 * locality; a bare locality is mapped only via KNOWN_LOCALITY_ISLANDS.
 * Returns null when the value cannot be classified confidently — callers
 * must report it for owner review instead of writing a guess.
 */
export function resolveVenueGeography(
  locationName: string | undefined
): VenueGeography | null {
  const parts = (locationName ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

  // The legacy Saba default for an empty location, preserved verbatim.
  if (parts.length === 0) return { island: "saba", locality: "" };

  const lastKey = islandKey(parts[parts.length - 1]);
  if (isVenueIsland(lastKey)) {
    return { island: lastKey, locality: parts.slice(0, -1).join(", ") };
  }

  const whole = parts.join(", ");
  const known = KNOWN_LOCALITY_ISLANDS.get(whole.toLowerCase());
  if (known) return { island: known, locality: whole };

  return null;
}

/**
 * Display heading for a canonical island key. Known islands return their
 * canonical label; an unknown future island key title-cases each word
 * rather than only the first letter of the whole string. `isVenueIsland`
 * (not a Record lookup) keeps keys colliding with Object.prototype members
 * on the unknown-island path.
 */
export function islandDisplayName(key: string): string {
  return isVenueIsland(key)
    ? VENUE_ISLAND_LABELS[key]
    : key.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

/**
 * Location line for a venue card. Migrated venues compose
 * "<locality>, <island>" from the canonical field using the short
 * jurisdiction label (e.g. "Philipsburg, Sint Maarten" — the
 * dual-jurisdiction label would be wrong as a locality address); a blank
 * locality — or one that already equals the island label — shows just the
 * whole-island label ("Saba", never "Saba, Saba"). Legacy records without
 * `island` keep showing their raw `locationName` unchanged.
 */
export function venueCardLocation(venue: Venue): string {
  if (!isVenueIsland(venue.island)) return venue.locationName;
  const locality = venue.locationName.trim();
  const cardLabel = VENUE_ISLAND_CARD_LABELS[venue.island];
  if (
    locality === "" ||
    locality.toLowerCase() === cardLabel.toLowerCase() ||
    locality.toLowerCase() === VENUE_ISLAND_LABELS[venue.island].toLowerCase()
  ) {
    return VENUE_ISLAND_LABELS[venue.island];
  }
  // A locality entered in the old combined format ("Windwardside, Saba")
  // already ends with the island name — show it as-is instead of producing
  // "Windwardside, Saba, Saba".
  if (islandKey(locality.split(",").pop()) === venue.island) {
    return locality;
  }
  return `${locality}, ${cardLabel}`;
}

/** Distinct canonical island keys across venues, ordered by display name. */
export function distinctIslands(venues: Venue[]): string[] {
  const keys = new Set(venues.map(venueIslandKey));
  return [...keys].sort((a, b) =>
    islandDisplayName(a).localeCompare(islandDisplayName(b))
  );
}

/**
 * Group venues by canonical island key, ordered by display name. Grouping by
 * the canonical `island` field means a locality like "Philipsburg" or
 * "Windwardside" can never become its own section (Issue #134); the legacy
 * `locationName` fallback inside `venueIslandKey` still merges spelling
 * variants like "SXM" and "Sint Maarten" for unmigrated records.
 */
export function groupVenuesByIsland(
  venues: Venue[]
): Array<{ key: string; venues: Venue[] }> {
  const byIsland = new Map<string, Venue[]>();
  for (const venue of venues) {
    const key = venueIslandKey(venue);
    byIsland.set(key, [...(byIsland.get(key) ?? []), venue]);
  }
  return [...byIsland.entries()]
    .sort(([a], [b]) => islandDisplayName(a).localeCompare(islandDisplayName(b)))
    .map(([key, islandVenues]) => ({ key, venues: islandVenues }));
}

/**
 * Filter semantics — simple AND across categories:
 * - beer alone: venue carries that beer in any format
 * - format alone: venue lists any beer in that format
 * - beer + format: venue lists that beer in that format
 * - island: venue's canonical island key matches
 * Format is single-select (All / On Tap / In Can), so there is no "both
 * selected" ambiguity to resolve.
 */
export function filterVenues(venues: Venue[], filters: VenueFilters): Venue[] {
  return venues.filter((venue) => {
    if (
      filters.island !== null &&
      venueIslandKey(venue) !== filters.island
    ) {
      return false;
    }
    if (
      filters.format !== null &&
      !venueOffersFormat(venue, filters.format, filters.beer)
    ) {
      return false;
    }
    if (
      filters.beer !== null &&
      filters.format === null &&
      !venueCarriesBeer(venue, filters.beer)
    ) {
      return false;
    }
    return true;
  });
}

export function hasActiveVenueFilters(filters: VenueFilters): boolean {
  return (
    filters.beer !== null || filters.format !== null || filters.island !== null
  );
}

/**
 * Beers a visitor can meaningfully filter by: public beers (already ordered
 * by sortOrder from getBeers) that at least one listed venue carries in some
 * format. Beers carried by no public venue, and non-public beers, are never
 * offered as options.
 */
export function carriedBeerOptions(
  venues: Venue[],
  beers: Beer[]
): BeerOption[] {
  const carried = new Set<string>();
  for (const venue of venues) {
    for (const slug of venue.carriesBeerSlugs ?? []) carried.add(slug);
    for (const slug of venue.tapBeerSlugs ?? []) carried.add(slug);
    for (const slug of venue.canBeerSlugs ?? []) carried.add(slug);
  }
  // `isPublic` is checked here too (not just in getBeers) so a non-public
  // beer referenced by a venue can never leak into the option list.
  return beers
    .filter((beer) => beer.isPublic && carried.has(beer.slug))
    .map((beer) => ({ slug: beer.slug, name: beer.name }));
}

/** True when any venue lists a beer under a format — otherwise the format
 *  control would only ever produce an empty result. */
export function hasAnyFormatData(venues: Venue[]): boolean {
  return venues.some(venueIsStocked);
}

/**
 * True when the venue lists at least one beer under a serving format — the
 * same "has beer" definition the card uses to render its On Tap / In Can
 * lists. `carriesBeerSlugs` alone does not count: a beer recorded there
 * without a format membership produces no visible inventory line, so the
 * card would still show no beer. Public /where-to-buy pages exclude
 * unstocked venues before grouping, filter options, and counts are derived.
 */
export function venueIsStocked(venue: Venue): boolean {
  return (
    (venue.tapBeerSlugs?.length ?? 0) > 0 ||
    (venue.canBeerSlugs?.length ?? 0) > 0
  );
}

const VALID_FORMATS: readonly string[] = ["tap", "can"];

/**
 * Parse `?beer=&format=&island=` from a URL query string. Unknown formats and
 * blank values are dropped; stale beer slugs / island keys are further
 * checked against the live option lists by `sanitizeVenueFilters`.
 */
export function parseVenueFilters(search: string): VenueFilters {
  const params = new URLSearchParams(search);
  const beer = params.get("beer")?.trim() || null;
  const formatParam = params.get("format");
  const island = params.get("island")?.trim() || null;
  return {
    beer,
    format: VALID_FORMATS.includes(formatParam ?? "")
      ? (formatParam as VenueFormat)
      : null,
    island,
  };
}

/** Serialize active filters back to a `?...` query string ("" when empty). */
export function venueFiltersToSearch(filters: VenueFilters): string {
  const params = new URLSearchParams();
  if (filters.beer) params.set("beer", filters.beer);
  if (filters.format) params.set("format", filters.format);
  if (filters.island) params.set("island", filters.island);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * Drop filter values that are not in the current public data set — e.g. a
 * stale beer slug from an old shared link. Never throws; invalid values
 * silently mean "unfiltered" so the page still shows every venue.
 */
export function sanitizeVenueFilters(
  filters: VenueFilters,
  allowed: { beerSlugs: ReadonlySet<string>; islands: ReadonlySet<string> }
): VenueFilters {
  return {
    beer:
      filters.beer !== null && allowed.beerSlugs.has(filters.beer)
        ? filters.beer
        : null,
    format: filters.format,
    island:
      filters.island !== null && allowed.islands.has(filters.island)
        ? filters.island
        : null,
  };
}
