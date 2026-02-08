import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { BeerCard } from "@/components/beer-card";
import { getBeers } from "@/lib/beers";

export const metadata: Metadata = {
  title: "Our Beers",
  description: "Explore the full range of beers from Deep Dive Brewing Co.",
};

export default async function BeersPage() {
  const beers = await getBeers();

  return (
    <main className="mx-auto max-w-300 px-6 py-20 md:py-30">
      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Our Beers
        </h1>
        <p className="mt-3 max-w-180 text-muted-foreground">
          From crisp lagers to bold stouts — every beer we brew reflects the
          island we call home.
        </p>
      </div>

      {/* Filter tabs */}
      <div className="mb-10 flex flex-wrap gap-2">
        {["All", "Core", "Seasonal", "Limited"].map((filter) => (
          <Badge
            key={filter}
            variant={filter === "All" ? "default" : "outline"}
            className="cursor-pointer px-4 py-1.5 text-sm"
          >
            {filter}
          </Badge>
        ))}
      </div>

      {/* Beer grid */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {beers.map((beer) => (
          <BeerCard key={beer.slug} beer={beer} />
        ))}
      </div>
    </main>
  );
}

