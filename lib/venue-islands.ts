// Canonical island vocabulary for venue records (Issue #134). The `island`
// field on a Venue is the controlled grouping identity; `locationName` is a
// free-text locality that must never determine island grouping.
//
// Firebase-free: this module is imported by client components, so it must
// never pull in the Firebase client SDK (see docs/operations/performance.md).

/** Stable machine values stored in the venue `island` field. */
export const VENUE_ISLAND_KEYS = ["saba", "sxm", "statia"] as const;

export type VenueIsland = (typeof VENUE_ISLAND_KEYS)[number];

const VENUE_ISLAND_SET: ReadonlySet<string> = new Set(VENUE_ISLAND_KEYS);

/** True when `value` is a canonical island key. */
export function isVenueIsland(value: unknown): value is VenueIsland {
  return typeof value === "string" && VENUE_ISLAND_SET.has(value);
}

/**
 * Whole-island customer-facing labels, used for /where-to-buy group headings
 * and island filter options. "sxm" is internal-only — the public label is the
 * full dual-jurisdiction name.
 */
export const VENUE_ISLAND_LABELS: Readonly<Record<VenueIsland, string>> = {
  saba: "Saba",
  sxm: "Sint Maarten / Saint Martin",
  statia: "Sint Eustatius / Statia",
};

/**
 * Short jurisdiction labels for composing "<locality>, <island>" card text.
 * The dual-jurisdiction whole-island label would read incorrectly as a
 * locality address — "Philipsburg, Sint Maarten" is right because Philipsburg
 * is on the Dutch side; "Philipsburg, Sint Maarten / Saint Martin" is not.
 */
export const VENUE_ISLAND_CARD_LABELS: Readonly<Record<VenueIsland, string>> = {
  saba: "Saba",
  sxm: "Sint Maarten",
  statia: "Statia",
};

/** Options for the admin venue editor's Island select (value + label pairs). */
export const VENUE_ISLAND_OPTIONS: ReadonlyArray<{
  value: VenueIsland;
  label: string;
}> = VENUE_ISLAND_KEYS.map((value) => ({
  value,
  label: VENUE_ISLAND_LABELS[value],
}));
