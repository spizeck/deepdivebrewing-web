"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { VenueCard } from "@/components/venue-card";
import { trackEvent } from "@/lib/analytics";
import {
  distinctIslands,
  EMPTY_VENUE_FILTERS,
  filterVenues,
  groupVenuesByIsland,
  hasActiveVenueFilters,
  hasAnyFormatData,
  islandDisplayName,
  parseVenueFilters,
  sanitizeVenueFilters,
  venueFiltersToSearch,
  type BeerOption,
  type VenueFilters,
  type VenueFormat,
} from "@/lib/venue-filters";
import type { Venue } from "@/lib/types";

const formatOptions: Array<{ label: string; value: VenueFormat | null }> = [
  { label: "All", value: null },
  { label: "On Tap", value: "tap" },
  { label: "In Can", value: "can" },
];

const selectClassName =
  "min-h-[44px] w-full rounded-md border border-stone bg-paper px-3 py-2 text-sm text-ink sm:w-auto";

interface VenueDirectoryProps {
  venues: Venue[];
  beerNameBySlug: Record<string, string>;
  beerOptions: BeerOption[];
}

/**
 * Client-side filtering layer for the /where-to-buy venue list. Receives the
 * already-fetched public venues/beers from the server page — no Firebase —
 * so the full venue list still ships in the initial HTML for SEO.
 *
 * Filter state mirrors the `?beer=&format=&island=` query string: sharing or
 * reloading a URL restores the selection, and back/forward navigates between
 * states. Stale values (e.g. a beer slug that no longer exists) are dropped
 * safely by sanitizeVenueFilters.
 */
export function VenueDirectory({
  venues,
  beerNameBySlug,
  beerOptions,
}: VenueDirectoryProps) {
  const [filters, setFilters] = useState<VenueFilters>(EMPTY_VENUE_FILTERS);

  const islands = useMemo(() => distinctIslands(venues), [venues]);
  const allowed = useMemo(
    () => ({
      beerSlugs: new Set(beerOptions.map((option) => option.slug)),
      islands: new Set(islands),
    }),
    [beerOptions, islands]
  );
  const showFormat = useMemo(() => hasAnyFormatData(venues), [venues]);

  // Read initial filters from the URL and re-apply on back/forward.
  useEffect(() => {
    const applyFromUrl = () =>
      setFilters(
        sanitizeVenueFilters(
          parseVenueFilters(window.location.search),
          allowed
        )
      );
    applyFromUrl();
    window.addEventListener("popstate", applyFromUrl);
    return () => window.removeEventListener("popstate", applyFromUrl);
  }, [allowed]);

  const applyFilters = (next: VenueFilters) => {
    setFilters(next);
    const search = venueFiltersToSearch(next);
    window.history.pushState(null, "", `${window.location.pathname}${search}`);
  };

  const trackFilter = (facet: string, value: string, extra?: { beer_slug?: string; island?: string }) =>
    trackEvent("beer_filter", {
      event_category: "engagement",
      event_label: facet,
      filter: value,
      cta_location: "where_to_buy_page",
      ...extra,
    });

  const onBeerChange = (slug: string | null) => {
    applyFilters({ ...filters, beer: slug });
    trackFilter("beer", slug ?? "all", slug ? { beer_slug: slug } : undefined);
  };

  const onFormatChange = (format: VenueFormat | null) => {
    applyFilters({ ...filters, format });
    trackFilter("format", format ?? "all");
  };

  const onIslandChange = (island: string | null) => {
    applyFilters({ ...filters, island });
    trackFilter("island", island ?? "all", island ? { island } : undefined);
  };

  const onClear = () => {
    applyFilters(EMPTY_VENUE_FILTERS);
    trackFilter("clear", "all");
  };

  const filtered = useMemo(() => filterVenues(venues, filters), [venues, filters]);
  const groups = useMemo(() => groupVenuesByIsland(filtered), [filtered]);
  const filtersActive = hasActiveVenueFilters(filters);
  const hasFilterControls =
    beerOptions.length > 0 || showFormat || islands.length > 1;

  return (
    <>
      {hasFilterControls && (
        <div
          className="mb-10 rounded-lg border border-stone bg-stone/20 p-5"
          role="group"
          aria-label="Filter venues"
        >
          <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
            {beerOptions.length > 0 && (
              <div>
                <label
                  htmlFor="venue-beer-filter"
                  className="mb-1 block text-sm font-medium text-ink"
                >
                  Beer
                </label>
                <select
                  id="venue-beer-filter"
                  value={filters.beer ?? ""}
                  onChange={(event) =>
                    onBeerChange(event.target.value || null)
                  }
                  className={selectClassName}
                >
                  <option value="">Any beer</option>
                  {beerOptions.map((option) => (
                    <option key={option.slug} value={option.slug}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {showFormat && (
              <div>
                <span
                  id="venue-format-filter-label"
                  className="mb-1 block text-sm font-medium text-ink"
                >
                  Format
                </span>
                <div
                  role="group"
                  aria-labelledby="venue-format-filter-label"
                  className="flex flex-wrap gap-2"
                >
                  {formatOptions.map((option) => (
                    <button
                      key={option.value ?? "all"}
                      type="button"
                      onClick={() => onFormatChange(option.value)}
                      aria-pressed={filters.format === option.value}
                      className="min-h-[44px] min-w-[44px] cursor-pointer rounded-md focus-visible:ring-2 focus-visible:ring-ocean/50"
                    >
                      <Badge
                        variant={
                          filters.format === option.value
                            ? "default"
                            : "outline"
                        }
                        className="px-4 py-2 text-sm"
                      >
                        {option.label}
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {islands.length > 1 && (
              <div>
                <label
                  htmlFor="venue-island-filter"
                  className="mb-1 block text-sm font-medium text-ink"
                >
                  Island
                </label>
                <select
                  id="venue-island-filter"
                  value={filters.island ?? ""}
                  onChange={(event) =>
                    onIslandChange(event.target.value || null)
                  }
                  className={selectClassName}
                >
                  <option value="">All islands</option>
                  {islands.map((key) => (
                    <option key={key} value={key}>
                      {islandDisplayName(key)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {filtersActive && (
              <button
                type="button"
                onClick={onClear}
                className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-stone bg-paper px-4 py-2 text-sm font-medium text-ink transition-opacity duration-200 hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ocean/50"
              >
                Clear filters
              </button>
            )}
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            Availability can change. Check with the venue if you&rsquo;re
            making a special trip.
          </p>
        </div>
      )}

      <p role="status" className="sr-only">
        {filtered.length === 1
          ? "1 venue shown"
          : `${filtered.length} venues shown`}
      </p>

      {groups.map((group) => (
        <section key={group.key} className="mb-12">
          <h2 className="mb-6 text-2xl font-bold tracking-tight">
            {islandDisplayName(group.key)}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {group.venues.map((venue) => (
              <VenueCard
                key={venue.slug}
                venue={venue}
                beerNameBySlug={beerNameBySlug}
              />
            ))}
          </div>
        </section>
      ))}

      {filtered.length === 0 && (
        <section className="mb-12 rounded-lg border border-stone bg-stone/20 p-5">
          <p className="text-muted-foreground">
            No venues match those filters. Try a different combination, or
            clear the filters to see every partner location.
          </p>
          <button
            type="button"
            onClick={onClear}
            className="mt-3 inline-flex min-h-[44px] items-center justify-center rounded-md border border-stone bg-paper px-4 py-2 text-sm font-medium text-ink transition-opacity duration-200 hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ocean/50"
          >
            Clear filters
          </button>
        </section>
      )}
    </>
  );
}
