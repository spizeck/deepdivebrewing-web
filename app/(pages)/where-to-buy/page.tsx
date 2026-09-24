import type { Metadata } from "next";
import { getVenues } from "@/lib/venues";
import { getBeers } from "@/lib/beers";
import { VenueDirectory } from "@/components/venue-directory";
import { serializeJsonLd } from "@/lib/json-ld";
import { buildBreweryJsonLd } from "@/lib/brewery-json-ld";
import {
  carriedBeerOptions,
  distinctIslands,
  venueIsStocked,
} from "@/lib/venue-filters";

export const metadata: Metadata = {
  title: "Where to Buy",
  description:
    "Find Deep Dive beer on Saba. Bars, restaurants, and retailers carrying our island-brewed beers, plus Sint Maarten / Saint Martin availability updates.",
  keywords: [
    "where to buy beer on Saba",
    "where to buy beer on Sint Maarten",
    "where to buy beer on Saint Martin",
    "where to buy beer on SXM",
    "where to buy beer on Sint Eustatius",
    "where to buy beer on Statia",
    "Deep Dive Brewing Co partners",
  ],
  alternates: {
    canonical: "/where-to-buy",
  },
  openGraph: {
    title: "Where to Buy | Deep Dive Brewing Co",
    description:
      "Find Deep Dive beer on Saba. Bars, restaurants, and retailers carrying our island-brewed beers, plus Sint Maarten / Saint Martin availability updates.",
    url: "/where-to-buy",
    images: [
      {
        url: "/photos/og-default.jpg",
        width: 1200,
        height: 630,
        alt: "Deep Dive Brewing Co",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Where to Buy | Deep Dive Brewing Co",
    description:
      "Find Deep Dive beer on Saba. Bars, restaurants, and retailers carrying our island-brewed beers, plus Sint Maarten / Saint Martin availability updates.",
    images: ["/photos/og-default.jpg"],
  },
};

export default async function WhereToBuyPage() {
  const [fetchedVenues, beers] = await Promise.all([getVenues(), getBeers()]);
  // Exclude venues with no current On Tap / In Can beer before any grouping,
  // option generation, or counting — a venue showing no inventory never
  // renders publicly (Issue #130).
  const venues = fetchedVenues.filter(venueIsStocked);
  const beerNameBySlug = Object.fromEntries(beers.map((beer) => [beer.slug, beer.name]));
  const beerOptions = carriedBeerOptions(venues, beers);
  const islands = distinctIslands(venues);
  const hasSxm = islands.includes("sxm");

  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Where can I buy Deep Dive beer on Saba?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Check the partner list on this page for currently active bars, restaurants, and retailers carrying our beer on Saba.",
        },
      },
      {
        "@type": "Question",
        name: "Where can I buy Deep Dive beer on Sint Maarten or Saint Martin?",
        acceptedAnswer: {
          "@type": "Answer",
          text: hasSxm
            ? "Partner locations in Sint Maarten / Saint Martin are listed below. We are actively adding additional accounts across the island."
            : "We are working to add partner locations in Sint Maarten / Saint Martin. Contact us or check back for updates.",
        },
      },
      {
        "@type": "Question",
        name: "Is Deep Dive beer available on Sint Eustatius (Statia)?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Distribution is expanding and additional partner availability in Statia is in progress.",
        },
      },
    ],
  };

  // Canonical Brewery entity — shared builder (lib/brewery-json-ld.ts,
  // Issue #107) so all pages emit the identical complete field set. The
  // FAQPage block above stays local: it mirrors this page's visible FAQ.
  const breweryJsonLd = buildBreweryJsonLd();

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(breweryJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(faqJsonLd) }}
      />

      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Where to Buy
        </h1>
        <p className="mt-3 max-w-180 text-muted-foreground">
          Find Deep Dive beers through our partner locations on Saba. We are
          expanding into Sint Maarten / Saint Martin and nearby islands; those locations
          will be added here as they come online.
        </p>
      </div>

      <section className="mb-10 rounded-lg border border-stone bg-stone/20 p-5">
        <h2 className="text-lg font-semibold text-ink">Regional Availability</h2>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li>
            <span className="font-medium text-ink">Saba:</span> active partner
            locations listed below.
          </li>
          <li>
            <span className="font-medium text-ink">Sint Maarten / Saint Martin:</span>{" "}
            {hasSxm
              ? "partner locations listed below; more coming soon."
              : "not currently listed; expansion in progress."}
          </li>
          <li>
            <span className="font-medium text-ink">Sint Eustatius / Statia:</span>{" "}
            expanding soon.
          </li>
        </ul>
      </section>

      {venues.length === 0 ? (
        <section className="mb-12 rounded-lg border border-stone bg-stone/20 p-5">
          <p className="text-muted-foreground">
            No partner locations are listed right now. Please check back soon or
            contact us directly.
          </p>
        </section>
      ) : (
        <VenueDirectory
          venues={venues}
          beerNameBySlug={beerNameBySlug}
          beerOptions={beerOptions}
        />
      )}

      <section className="mt-12 rounded-lg border border-stone bg-paper p-6">
        <h2 className="text-xl font-bold tracking-tight">Where to Buy FAQ</h2>
        <div className="mt-4 space-y-4 text-sm text-muted-foreground">
          <div>
            <h3 className="font-semibold text-ink">Where can I buy Deep Dive beer on Saba?</h3>
            <p className="mt-1">
              Check the partner list above for currently active bars,
              restaurants, and retailers carrying our beer on Saba.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-ink">Where can I buy Deep Dive beer on Sint Maarten or Saint Martin?</h3>
            <p className="mt-1">
              {hasSxm
                ? "Partner locations in Sint Maarten / Saint Martin are listed above. We are actively adding more partner accounts across the island."
                : "We are working to add partner locations in Sint Maarten / Saint Martin. Contact us or check back for updates."}
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-ink">Is Deep Dive beer available on Sint Eustatius (Statia)?</h3>
            <p className="mt-1">
              Not yet at scale, but we are actively working to expand into
              Statia and nearby islands.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
