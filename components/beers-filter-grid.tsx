"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn, pressableClasses } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";
import { BeerCard } from "@/components/beer-card";
import type { Beer } from "@/lib/types";

type BeerFilter = "all" | Beer["status"];

const filterOptions: Array<{ label: string; value: BeerFilter }> = [
  { label: "All", value: "all" },
  { label: "Core", value: "core" },
  { label: "Seasonal", value: "seasonal" },
  { label: "Limited", value: "limited" },
];

interface BeersFilterGridProps {
  beers: Beer[];
}

export function BeersFilterGrid({ beers }: BeersFilterGridProps) {
  const [activeFilter, setActiveFilter] = useState<BeerFilter>("all");

  const filteredBeers = useMemo(() => {
    if (activeFilter === "all") return beers;
    return beers.filter((beer) => beer.status === activeFilter);
  }, [activeFilter, beers]);

  return (
    <>
      <div className="mb-10 flex flex-wrap gap-2" role="group" aria-label="Filter beers by status">
        {filterOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              setActiveFilter(option.value);
              trackEvent("beer_filter", {
                event_category: "engagement",
                filter: option.value,
                cta_location: "beers_page",
              });
            }}
            className={cn(
              "min-h-[44px] min-w-[44px] cursor-pointer rounded-md hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ocean/50",
              pressableClasses
            )}
            aria-pressed={activeFilter === option.value}
          >
            <Badge
              variant={activeFilter === option.value ? "default" : "outline"}
              className="px-4 py-2 text-sm"
            >
              {option.label}
            </Badge>
          </button>
        ))}
      </div>

      <p className="sr-only" role="status">
        {filteredBeers.length === 1
          ? "1 beer shown"
          : `${filteredBeers.length} beers shown`}
      </p>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {filteredBeers.map((beer, index) => (
          // The first card is the route's LCP image on mobile; keep the rest lazy.
          <BeerCard key={beer.slug} beer={beer} priority={index === 0} />
        ))}
      </div>

      {filteredBeers.length === 0 && activeFilter === "all" && (
        <section className="rounded-lg border border-stone bg-stone/20 p-5">
          <p className="text-muted-foreground">
            No beers on the list right now — availability changes with the
            season.
          </p>
        </section>
      )}
      {filteredBeers.length === 0 && activeFilter !== "all" && (
        <section className="rounded-lg border border-stone bg-stone/20 p-5">
          <p className="text-muted-foreground">
            No{" "}
            {filterOptions
              .find((option) => option.value === activeFilter)
              ?.label.toLowerCase()}{" "}
            beers on the list right now — availability changes with the
            season. The full lineup is still on tap.
          </p>
          <button
            type="button"
            onClick={() => {
              setActiveFilter("all");
              trackEvent("beer_filter", {
                event_category: "engagement",
                filter: "all",
                cta_location: "beers_page",
              });
            }}
            className={cn(
              "mt-3 inline-flex min-h-[44px] items-center justify-center rounded-md border border-stone bg-paper px-4 py-2 text-sm font-medium text-ink hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ocean/50",
              pressableClasses
            )}
          >
            Show all beers
          </button>
        </section>
      )}
    </>
  );
}
