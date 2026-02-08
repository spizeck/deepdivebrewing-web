import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
// import { getVenues } from "@/lib/venues";
// import { VenueCard } from "@/components/venue-card";

export const metadata: Metadata = {
  title: "Where to Buy",
  description:
    "Find bars, restaurants, and retailers that carry Deep Dive Brewing Co beers.",
};

export default async function WhereToBuyPage() {
  // TODO: Uncomment when Firestore is connected
  // const venues = await getVenues();

  return (
    <main className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Where to Buy
        </h1>
        <p className="mt-3 max-w-180 text-muted-foreground">
          Find Deep Dive beers at these bars, restaurants, and retailers.
        </p>
      </div>

      {/* Filter by venue type */}
      <div className="mb-10 flex flex-wrap gap-2">
        {["All", "Bar", "Restaurant", "Hotel", "Retail"].map((filter) => (
          <Badge
            key={filter}
            variant={filter === "All" ? "default" : "outline"}
            className="cursor-pointer px-4 py-1.5 text-sm"
          >
            {filter}
          </Badge>
        ))}
      </div>

      {/* Venue list */}
      {/* TODO: Replace placeholders with <VenueCard venue={venue} /> mapped from Firestore data */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <VenueCardPlaceholder />
        <VenueCardPlaceholder />
        <VenueCardPlaceholder />
        <VenueCardPlaceholder />
      </div>
    </main>
  );
}

function VenueCardPlaceholder() {
  return (
    <div className="rounded-lg border border-stone bg-paper p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="h-5 w-40 rounded bg-stone/50" />
          <div className="h-4 w-24 rounded bg-stone/50" />
        </div>
        <div className="h-6 w-16 rounded-full bg-stone/50" />
      </div>
      <div className="mt-4 flex gap-4">
        <div className="h-4 w-16 rounded bg-stone/50" />
        <div className="h-4 w-20 rounded bg-stone/50" />
      </div>
    </div>
  );
}
