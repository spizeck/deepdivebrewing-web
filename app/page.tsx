import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import IntroSection from "@/components/home/IntroSection";
import type { CSSProperties } from "react";

export default function Home() {
  return (
    <main>
      {/* Hero — full viewport, grain photo */}
      <section className="relative h-dvh w-full overflow-hidden">
        <Image
          src="/photos/herograin.jpg"
          alt="Barley grain close-up"
          fill
          priority
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-ink/60" />
        <div className="animate-hero-fade relative z-10 flex h-full flex-col items-center justify-center px-6 text-center">
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
      <section className="animate-fade-in animate-delay-2 relative h-dvh w-full overflow-hidden">
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
              <Link href="/about">See How We Brew</Link>
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
          {/* TODO: Fetch featured/core beers from Firestore and render BeerCard grid */}
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <BeerCardPlaceholder />
            <BeerCardPlaceholder />
            <BeerCardPlaceholder />
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
  );
}

function BeerCardPlaceholder() {
  return (
    <div className="rounded-lg border border-stone bg-paper p-6">
      <div className="aspect-4/5 w-full rounded bg-stone/50" />
      <div className="mt-4 space-y-2">
        <div className="h-5 w-2/3 rounded bg-stone/50" />
        <div className="h-4 w-1/3 rounded bg-stone/50" />
      </div>
    </div>
  );
}
