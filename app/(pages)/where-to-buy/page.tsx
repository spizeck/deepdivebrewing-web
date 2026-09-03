import type { Metadata } from "next";
import { getVenues } from "@/lib/venues";
import { getBeers } from "@/lib/beers";
import { VenueCard } from "@/components/venue-card";
import type { Venue } from "@/lib/types";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://deepdivebrewing.com";

export const metadata: Metadata = {
  title: "Where to Buy",
  description:
    "Find Deep Dive beer on Saba. Bars, restaurants, and retailers carrying our island-brewed beers, plus SXM availability updates.",
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
};

function groupByIsland(venues: Venue[]): Record<string, Venue[]> {
  return venues.reduce<Record<string, Venue[]>>((acc, venue) => {
    const island = venue.locationName || "Saba";
    acc[island] = acc[island] ?? [];
    acc[island].push(venue);
    return acc;
  }, {});
}

function islandDisplayName(island: string): string {
  const normalized = island.trim().toLowerCase();
  if (normalized === "sxm" || normalized.includes("maarten") || normalized.includes("martin")) {
    return "Sint Maarten / Saint Martin / SXM";
  }
  if (normalized.includes("statia") || normalized.includes("eustatius")) {
    return "Sint Eustatius / Statia";
  }
  // Capitalize first letter for Saba or any other value.
  return island.charAt(0).toUpperCase() + island.slice(1);
}

export default async function WhereToBuyPage() {
  const [venues, beers] = await Promise.all([getVenues(), getBeers()]);
  const beerNameBySlug = Object.fromEntries(beers.map((beer) => [beer.slug, beer.name]));
  const byIsland = groupByIsland(venues);
  const islands = Object.keys(byIsland).sort();
  const hasSxm = islands.some((island) => {
    const normalized = island.trim().toLowerCase();
    return (
      normalized === "sxm" ||
      normalized.includes("maarten") ||
      normalized.includes("martin")
    );
  });

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
        name: "Where can I buy Deep Dive beer on Sint Maarten, Saint Martin, or SXM?",
        acceptedAnswer: {
          "@type": "Answer",
          text: hasSxm
            ? "Partner locations in SXM are listed below. We are actively adding additional accounts across the island."
            : "We are working to add partner locations in SXM. Contact us or check back for updates.",
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

  const localBusinessJsonLd = {
    "@context": "https://schema.org",
    "@type": "Brewery",
    "@id": `${siteUrl}/#brewery`,
    name: "Deep Dive Brewing Co",
    url: siteUrl,
    telephone: "+599-416-3544",
    email: "info@deepdivebrewing.com",
    address: {
      "@type": "PostalAddress",
      streetAddress: "66 Fort Bay Road",
      addressLocality: "The Bottom",
      addressCountry: "BQ",
    },
    areaServed: ["Saba", "Sint Maarten", "Saint Martin", "SXM", "Sint Eustatius", "Statia"],
  };

  return (
    <main id="main-content" className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(localBusinessJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Where to Buy
        </h1>
        <p className="mt-3 max-w-180 text-muted-foreground">
          Find Deep Dive beers through our partner locations on Saba. We are
          expanding into Sint Maarten / SXM and nearby islands; those locations
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
            <span className="font-medium text-ink">Sint Maarten / Saint Martin / SXM:</span>{" "}
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

      {islands.map((island) => (
        <section key={island} className="mb-12">
          <h2 className="mb-6 text-2xl font-bold tracking-tight">
            {islandDisplayName(island)}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {byIsland[island].map((venue: Venue) => (
              <VenueCard key={venue.slug} venue={venue} beerNameBySlug={beerNameBySlug} />
            ))}
          </div>
        </section>
      ))}

      {islands.length === 0 && (
        <section className="mb-12 rounded-lg border border-stone bg-stone/20 p-5">
          <p className="text-muted-foreground">
            No partner locations are listed right now. Please check back soon or
            contact us directly.
          </p>
        </section>
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
            <h3 className="font-semibold text-ink">Where can I buy Deep Dive beer on Sint Maarten, Saint Martin, or SXM?</h3>
            <p className="mt-1">
              {hasSxm
                ? "Partner locations in SXM are listed above. We are actively adding more partner accounts across the island."
                : "We are working to add partner locations in SXM. Contact us or check back for updates."}
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
