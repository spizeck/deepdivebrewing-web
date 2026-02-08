import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { BeerCard } from "@/components/beer-card";
import type { Beer } from "@/lib/types";
// import { getBeers } from "@/lib/beers";

export const metadata: Metadata = {
  title: "Our Beers",
  description: "Explore the full range of beers from Deep Dive Brewing Co.",
};

export default async function BeersPage() {
  // TODO: Uncomment when Firestore is connected
  // const beers = await getBeers();

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
      {/* TODO: Replace placeholders with <BeerCard beer={beer} /> mapped from Firestore data */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {/* Test NEIPA beer - replace with Firestore data */}
        <BeerCard
          beer={{
            name: "New England IPA",
            style: "New England IPA",
            slug: "neipa",
            abv: 6.3,
            ibu: 47,
            srm: 5.2,
            status: "core" as const,
            descriptionShort:
              "This New England IPA brings the tropical essence of Saba straight to your glass. Crafted with malts from North America, including Canada and the U.S., this brew has a silky-smooth texture thanks to the addition of wheat and oats. The bitterness from Cascade hops is perfectly balanced, while the generous addition of Citra hops—both at flame-out and dry hop—unleashes a juicy burst of citrus and tropical fruits like grapefruit, mango, and passionfruit.",
            tastingNotes: ["Grapefruit", "Passionfruit", "Mango", "Smooth finish"],
            images: {
              card: "https://firebasestorage.googleapis.com/v0/b/deepdivebrewing-web.firebasestorage.app/o/beers%2Fneipa%2Fneipa_card_1200x1500.jpg?alt=media",
              hero: "https://firebasestorage.googleapis.com/v0/b/deepdivebrewing-web.firebasestorage.app/o/beers%2Fneipa%2Fneipa_hero_1920x1080.jpg?alt=media",
            },
            isPublic: true,
            sortOrder: 1,
          }}
        />
        <BeerCardPlaceholder />
        <BeerCardPlaceholder />
        <BeerCardPlaceholder />
        <BeerCardPlaceholder />
        <BeerCardPlaceholder />
      </div>
    </main>
  );
}

function BeerCardPlaceholder() {
  return (
    <div className="rounded-lg border border-stone bg-paper p-6">
      <div className="aspect-4/5 w-full rounded bg-stone/50" />
      <div className="mt-4 space-y-2">
        <div className="h-5 w-2/3 rounded bg-stone/50" />
        <div className="h-4 w-1/3 rounded bg-stone/50" />
        <div className="mt-3 flex gap-2">
          <div className="h-6 w-16 rounded-full bg-stone/50" />
          <div className="h-6 w-14 rounded-full bg-stone/50" />
        </div>
      </div>
    </div>
  );
}
