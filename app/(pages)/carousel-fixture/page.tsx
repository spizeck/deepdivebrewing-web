import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BeerCarousel } from "@/components/beer-carousel";
import {
  CAROUSEL_FIXTURE_BEERS,
  CAROUSEL_FIXTURE_IMAGE,
} from "@/lib/carousel-fixture";

// Test-only rendering of the homepage beer carousel for the Playwright smoke
// suite. The env var is a server-only check evaluated per request
// (force-dynamic): it is set exclusively by the Playwright webServer config,
// so in any normal deployment — including Vercel builds — this route returns
// 404 and serves nothing. It grants no access to real data: the carousel
// renders hardcoded fixture records and never reaches Firebase; the real
// homepage flow is unchanged.

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Carousel fixture",
  robots: { index: false, follow: false },
};

export default function CarouselFixturePage() {
  if (process.env.CAROUSEL_FIXTURE !== "1") {
    notFound();
  }

  const imageUrls = Object.fromEntries(
    CAROUSEL_FIXTURE_BEERS.map((beer) => [beer.slug, CAROUSEL_FIXTURE_IMAGE])
  );

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto max-w-300 px-6 pb-20 md:pb-30"
    >
      <h1 className="mb-12 text-3xl font-bold tracking-tight md:text-4xl">
        Our Beers
      </h1>
      <BeerCarousel beers={CAROUSEL_FIXTURE_BEERS} imageUrls={imageUrls} />
    </main>
  );
}
