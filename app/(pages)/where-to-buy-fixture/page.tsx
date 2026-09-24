import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { VenueDirectory } from "@/components/venue-directory";
import {
  WHERE_TO_BUY_FIXTURE_BEERS,
  WHERE_TO_BUY_FIXTURE_VENUES,
} from "@/lib/where-to-buy-fixture";
import { carriedBeerOptions, venueIsStocked } from "@/lib/venue-filters";

// Test-only rendering of the /where-to-buy filter experience for the
// Playwright smoke suite. The env var is a server-only check evaluated per
// request (force-dynamic): it is set exclusively by the Playwright webServer
// config, so in any normal deployment — including Vercel builds — this route
// returns 404 and serves nothing. It grants no access to real data: the
// directory renders hardcoded fixture records and never reaches Firebase;
// the real /where-to-buy flow is unchanged.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Where to buy fixture",
  robots: { index: false, follow: false },
};

export default function WhereToBuyFixturePage() {
  if (process.env.WHERE_TO_BUY_FIXTURE !== "1") {
    notFound();
  }

  // Mirror the production page's stocked-venue exclusion so the fixture
  // exercises the same public-display rule (Issue #130).
  const venues = WHERE_TO_BUY_FIXTURE_VENUES.filter(venueIsStocked);
  const beers = WHERE_TO_BUY_FIXTURE_BEERS;
  const beerNameBySlug = Object.fromEntries(
    beers.map((beer) => [beer.slug, beer.name])
  );

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto max-w-300 px-6 pb-20 md:pb-30"
    >
      <h1 className="mb-12 text-3xl font-bold tracking-tight md:text-4xl">
        Where to Buy
      </h1>
      <VenueDirectory
        venues={venues}
        beerNameBySlug={beerNameBySlug}
        beerOptions={carriedBeerOptions(venues, beers)}
      />
    </main>
  );
}
