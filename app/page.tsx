import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header";
import IntroSection from "@/components/home/IntroSection";
import { BeerCarousel } from "@/components/beer-carousel";
import { getBeers, beerImageUrl } from "@/lib/beers";
import type { CSSProperties } from "react";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://deepdivebrewing.com";

export const metadata: Metadata = {
  title: "Craft Beer on Saba",
  description:
    "Deep Dive Brewing Co is Saba's craft brewery. Find where to buy our beer across Saba and SXM, and contact us for wholesale partnerships.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Deep Dive Brewing Co",
    description:
      "Saba's craft brewery. Discover locally brewed beers and where to find them on the island.",
    url: "/",
    images: [
      {
        url: "/photos/herograin.jpg",
        width: 1200,
        height: 630,
        alt: "Deep Dive Brewing Co hero image",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Deep Dive Brewing Co",
    description:
      "Saba's craft brewery. Discover locally brewed beers and where to find them on the island.",
    images: ["/photos/herograin.jpg"],
  },
};

export default async function Home() {
  const beers = await getBeers();
  const featuredBeers = beers.slice(0, 6);
  const imageUrls = Object.fromEntries(
    featuredBeers.map((b) => [b.slug, beerImageUrl(b.images.cardPath)])
  );
  const organizationJsonLd = {
    "@context": "https://schema.org",
    "@type": "Brewery",
    name: "Deep Dive Brewing Co",
    legalName: "Deep Dive Brews, BV",
    url: siteUrl,
    image: `${siteUrl}/photos/herograin.jpg`,
    email: "info@deepdivebrewing.com",
    telephone: "+599-416-3544",
    address: {
      "@type": "PostalAddress",
      streetAddress: "66 Fort Bay Road",
      addressLocality: "The Bottom",
      addressCountry: "BQ",
    },
    areaServed: ["Saba", "Sint Maarten", "Saint Martin", "SXM"],
    openingHoursSpecification: [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
        ],
        opens: "08:00",
        closes: "15:00",
      },
    ],
    description:
      "Craft brewery based on Saba producing locally brewed beer with island-wide and regional partner distribution.",
    sameAs: [
      "https://www.instagram.com/deepdivebrewing",
      "https://www.facebook.com/deepdivebrewing",
      "https://untappd.com/DeepDiveBrewingCo",
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
      />
      <SiteHeader />
      <main>
        {/* Hero — full viewport, grain photo, extends behind header */}
        <section className="relative h-screen w-full overflow-hidden">
        <Image
          src="/photos/herograin.jpg"
          alt="Barley grain close-up"
          fill
          priority
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-ink/60" />
        <div className="relative z-10 flex h-full flex-col items-center justify-center px-6 text-center animate-hero-fade">
          <h1
            className="text-4xl font-festival tracking-tight text-paper sm:text-5xl md:text-6xl"
            style={
              {
                textShadow: "2px 2px 4px rgba(11, 15, 20, 0.8)",
              } satisfies CSSProperties
            }
          >
            Deep Dive
            <br />
            Brewing Co
          </h1>
          <p className="mt-4 max-w-lg text-lg text-paper/90">
            Craft beer, brewed on Saba.
          </p>
          <div className="mt-8 flex gap-4">
            <Button asChild>
              <Link href="/beers">Explore Our Beers</Link>
            </Button>
            <Button
              variant="outline"
              asChild
              className="border-paper/30 text-paper hover:bg-paper/10"
            >
              <Link href="/where-to-buy">Where to Buy</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Introduction — bridge between hero and video */}
      <IntroSection>
        <div className="mx-auto max-w-180 text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Locally Crafted Brews
          </h2>
          <p className="mt-4 text-muted-foreground">
            Welcome to Deep Dive Brewing Co, the first craft brewery on the
            Island of Saba. Our locally crafted beers are inspired by the
            amazing nature of our special island. Dive in!
          </p>
        </div>
      </IntroSection>

      {/* Brewery video — full bleed background with content overlay */}
      <section className="animate-fade-in animate-delay-2 relative h-screen w-full overflow-hidden">
        <video
          className="absolute inset-0 h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster="/photos/herograin.jpg"
        >
          <source src="/videos/ddbwebvid.mp4" type="video/mp4" />
          <source src="/videos/ddbwebvid.webm" type="video/webm" />
          Your browser does not support the video tag.
        </video>
        <div className="absolute inset-0 bg-ink/60" />
        <div className="relative z-10 flex h-full flex-col items-center justify-center px-6 text-center">
          <h2 className="text-4xl font-bold tracking-tight text-paper sm:text-5xl md:text-6xl">
            The Brewery
          </h2>
          <p className="mt-4 max-w-lg text-lg text-paper/80">
            Brewing is equal parts craft and control. We track our process
            carefully so every batch is clean, consistent, and true to style —
            whether it’s a crisp lager or a seasonal release. Take a peek behind
            the scenes.
          </p>
          <div className="mt-8">
            <Button
              asChild
              variant="outline"
              className="border-paper/30 text-paper hover:bg-paper/10"
            >
              <Link href="/about">Learn More</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Featured beers teaser */}
      <section className="animate-fade-in animate-delay-3 border-t border-stone">
        <div className="mx-auto max-w-300 px-6 py-20 md:py-30">
          <div className="flex items-end justify-between">
            <h2 className="text-3xl font-bold tracking-tight">Our Beers</h2>
            <Link
              href="/beers"
              className="text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85"
            >
              View all &rarr;
            </Link>
          </div>
          <div className="mt-10">
            <BeerCarousel beers={featuredBeers} imageUrls={imageUrls} />
          </div>
        </div>
      </section>

      {/* Where to find us teaser */}
      <section className="animate-fade-in animate-delay-4 border-t border-stone">
        <div className="mx-auto max-w-300 px-6 py-20 md:py-30">
          <div className="mx-auto max-w-180 text-center">
            <h2 className="text-3xl font-bold tracking-tight">
              Where to Find Us
            </h2>
            <p className="mt-4 text-muted-foreground">
              Our beers are available at select bars, restaurants, and
              retailers.
            </p>
            <div className="mt-8">
              <Button asChild variant="outline">
                <Link href="/where-to-buy">See Locations</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
      </main>
    </>
  );
}

