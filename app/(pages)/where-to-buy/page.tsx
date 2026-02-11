import type { Metadata } from "next";
import { getVenues } from "@/lib/venues";
import { VenueCard } from "@/components/venue-card";
import type { Venue } from "@/lib/types";

export const metadata: Metadata = {
  title: "Where to Buy",
  description:
    "Find bars, restaurants, and retailers that carry Deep Dive Brewing Co beers.",
};

export default async function WhereToBuyPage() {
  const venues = await getVenues();

  const barRestaurants = venues.filter((v: Venue) => v.type === "bar_restaurant");
  const retail = venues.filter((v: Venue) => v.type === "retail");

  return (
    <main className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Where to Buy
        </h1>
        <p className="mt-3 max-w-180 text-muted-foreground">
          Find Deep Dive beers at these bars, restaurants, and retailers on Saba.
        </p>
      </div>

      {/* Bars & Restaurants */}
      {barRestaurants.length > 0 && (
        <section className="mb-12">
          <h2 className="mb-6 text-2xl font-bold tracking-tight">
            Bars &amp; Restaurants
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {barRestaurants.map((venue: Venue) => (
              <VenueCard key={venue.slug} venue={venue} />
            ))}
          </div>
        </section>
      )}

      {/* Retail */}
      {retail.length > 0 && (
        <section>
          <h2 className="mb-6 text-2xl font-bold tracking-tight">Retail</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {retail.map((venue: Venue) => (
              <VenueCard key={venue.slug} venue={venue} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
