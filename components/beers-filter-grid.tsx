"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
      <div className="mb-10 flex flex-wrap gap-2">
        {filterOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setActiveFilter(option.value)}
            className="cursor-pointer"
            aria-pressed={activeFilter === option.value}
          >
            <Badge
              variant={activeFilter === option.value ? "default" : "outline"}
              className="px-4 py-1.5 text-sm"
            >
              {option.label}
            </Badge>
          </button>
        ))}
      </div>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {filteredBeers.map((beer) => (
          <BeerCard key={beer.slug} beer={beer} />
        ))}
      </div>
    </>
  );
}
