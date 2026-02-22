import type { Metadata } from "next";
import Link from "next/link";
import { BeersFilterGrid } from "@/components/beers-filter-grid";
import { getBeers } from "@/lib/beers";

export const metadata: Metadata = {
  title: "Our Beers",
  description:
    "Explore beers from Deep Dive Brewing Co, including NEIPA, American Amber, Pale Lager, and Tropical Wheat brewed on Saba.",
  keywords: [
    "Saba craft beer",
    "NEIPA Saba",
    "American Amber beer",
    "Pale Lager Saba",
    "Tropical Wheat beer",
    "Deep Dive Brewing beers",
  ],
  alternates: {
    canonical: "/beers",
  },
};

export default async function BeersPage() {
  const beers = await getBeers();

  return (
    <main className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Our Beers
        </h1>
        <p className="mt-3 max-w-180 text-muted-foreground">
          From crisp lagers to bold stouts — every beer we brew reflects the
          island we call home.
        </p>
      </div>

      <section className="mb-10 rounded-lg border border-stone bg-stone/20 p-5">
        <h2 className="text-lg font-semibold text-ink">Flagship Styles</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Current customer favorites include NEIPA, American Amber, Pale Lager,
          and Tropical Wheat. Availability can vary by season and partner
          location.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Looking for a specific beer? See our latest partner list on the{" "}
          <Link href="/where-to-buy" className="font-medium text-ocean hover:opacity-85">
            Where to Buy page
          </Link>
          .
        </p>
      </section>

      <BeersFilterGrid beers={beers} />

      <section className="mt-12 rounded-lg border border-stone bg-paper p-6">
        <h2 className="text-xl font-bold tracking-tight">Food Pairing Ideas</h2>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-ink">NEIPA:</span> spicy dishes,
            grilled fish, and rich cheeses.
          </li>
          <li>
            <span className="font-medium text-ink">American Amber:</span>
            burgers, barbecue, roasted chicken, and aged gouda.
          </li>
          <li>
            <span className="font-medium text-ink">Pale Lager:</span> shellfish,
            ceviche, salads, and light fried foods.
          </li>
          <li>
            <span className="font-medium text-ink">Tropical Wheat:</span>
            citrus-forward dishes, seafood, and island-style lunches.
          </li>
        </ul>
      </section>

      <section className="mt-8 rounded-lg border border-stone bg-paper p-6">
        <h2 className="text-xl font-bold tracking-tight">For Partners</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Interested in carrying Deep Dive Brewing Co? Start with our trade
          inquiry form and we&rsquo;ll help you find the right mix for your venue.
        </p>
        <Link href="/trade" className="mt-3 inline-block text-sm font-medium text-ocean hover:opacity-85">
          Submit a trade inquiry &rarr;
        </Link>
      </section>
    </main>
  );
}

