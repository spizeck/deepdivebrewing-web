import type { Metadata } from "next";
import { getVenues } from "@/lib/venues";
import { VenueCard } from "@/components/venue-card";
import type { Venue } from "@/lib/types";

export const metadata: Metadata = {
  title: "Where to Buy",
  description:
    "Where to buy Deep Dive beer on Saba, Sint Maarten (SXM), Saint Martin, and soon Sint Eustatius (Statia).",
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

export default async function WhereToBuyPage() {
  const venues = await getVenues();

  const barRestaurants = venues.filter((v: Venue) => v.type === "bar_restaurant");
  const retail = venues.filter((v: Venue) => v.type === "retail");
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
          text: "Deep Dive beer is available at select partner locations and we are actively adding additional partner accounts across SXM.",
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

  return (
    <main className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      <div className="mb-12">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
          Where to Buy
        </h1>
        <p className="mt-3 max-w-180 text-muted-foreground">
          Find Deep Dive beers through our partner locations. We currently serve
          Saba and select accounts in SXM, with more partner locations being
          added regularly.
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
            currently at select partner locations, with additional accounts
            coming soon.
          </li>
          <li>
            <span className="font-medium text-ink">Sint Eustatius / Statia:</span>{" "}
            expanding soon.
          </li>
        </ul>
      </section>

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
              We are already available at select locations and actively adding
              more partner accounts across SXM.
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
