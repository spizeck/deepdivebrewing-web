import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/reveal";
import { TourInquiryCta } from "@/components/tour-inquiry-cta";
import {
  EditorialFigure,
  EditorialSplit,
  ProcessStep,
  ProcessSteps,
  SectionIntro,
} from "@/components/editorial";
import { serializeJsonLd } from "@/lib/json-ld";
import { buildBreweryJsonLd } from "@/lib/brewery-json-ld";
import { BUSINESS_NAME } from "@/lib/site";

// Editorial feature page (Issue #192). Every factual claim below is sourced
// from existing repository copy: chiefly /about, /contact, /trade, and
// /where-to-buy. Editorial TODO comments mark spots where verified detail
// from the owner would improve the story; none are rendered.

const DESCRIPTION =
  "What it takes to brew craft beer on Saba, a five-square-mile island in the Caribbean Netherlands. Ocean freight, an all-electric brewhouse at Fort Bay, and beer made for the island.";

export const metadata: Metadata = {
  title: "Brewed on Saba",
  description: DESCRIPTION,
  keywords: [
    "brewed on Saba",
    "Saba brewery",
    "craft beer Saba",
    "Caribbean craft brewery",
    "Fort Bay brewery",
  ],
  alternates: {
    canonical: "/brewed-on-saba",
  },
  openGraph: {
    title: `Brewed on Saba | ${BUSINESS_NAME}`,
    description: DESCRIPTION,
    url: "/brewed-on-saba",
    images: [
      {
        url: "/photos/og-default.jpg",
        width: 1200,
        height: 630,
        alt: "Deep Dive Brewing Co brewery",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `Brewed on Saba | ${BUSINESS_NAME}`,
    description: DESCRIPTION,
    images: ["/photos/og-default.jpg"],
  },
};

export default function BrewedOnSabaPage() {
  // Canonical Brewery entity: shared builder (lib/brewery-json-ld.ts,
  // Issue #107) so all pages emit the identical complete field set.
  const breweryJsonLd = buildBreweryJsonLd();

  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(breweryJsonLd) }}
      />

      {/* Title block */}
      <header className="max-w-180">
        <p className="text-xs font-semibold uppercase tracking-wider text-moss">
          The Island &amp; the Beer
        </p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight md:text-5xl">
          Brewed on Saba
        </h1>
        <p className="mt-4 text-lg text-muted-foreground">
          Deep Dive Brewing Co is the first craft brewery on Saba, a
          five-square-mile island in the Caribbean Netherlands. This is what
          it takes to make beer here.
        </p>
      </header>

      {/* Lead image: the page's likely LCP, so it alone gets priority. */}
      <EditorialFigure
        src="/photos/PXL_20261006_121628797.jpg"
        alt="Single-infusion mash underway in the Alpha mash tun"
        caption="Single-infusion mash underway in the mash tun."
        priority
        className="mt-10"
      />

      {/* 1 · Brewed here */}
      <Reveal as="section" className="mt-20 md:mt-28">
        <SectionIntro eyebrow="The Brewery" title="Brewed here">
          <p>
            Deep Dive is a small, family-run brewery at Fort Bay Harbor on
            Saba. The brewery is a single room of about 63 m² (678 ft²)
            with nine-foot ceilings, compact by any standard and shaped
            entirely by the island around it.
          </p>
          <p className="mt-4">
            We brew approachable, well-balanced beer for our climate and our
            community, made for warm days, long evenings, and shared tables.
          </p>
        </SectionIntro>

        {/* Pull-stats: every figure is a verified fact from existing site
            copy, not an infographic. */}
        <dl className="mt-12 grid grid-cols-2 gap-x-6 gap-y-10 border-t border-stone pt-10 sm:grid-cols-4">
          <div>
            <dt className="sr-only">Brewery footprint</dt>
            <dd className="text-3xl font-bold tracking-tight">≈ 63 m²</dd>
            <dd className="mt-1 text-sm text-muted-foreground">
              ≈ 678 ft², wall to wall
            </dd>
          </div>
          <div>
            <dt className="sr-only">Container cadence</dt>
            <dd className="text-3xl font-bold tracking-tight">Every 2 weeks</dd>
            <dd className="mt-1 text-sm text-muted-foreground">
              Between shared-container arrivals
            </dd>
          </div>
          <div>
            <dt className="sr-only">Brewhouse energy</dt>
            <dd className="text-3xl font-bold tracking-tight">All-electric</dd>
            <dd className="mt-1 text-sm text-muted-foreground">
              Gas is prohibitively expensive on Saba
            </dd>
          </div>
          <div>
            <dt className="sr-only">First beer sold</dt>
            <dd className="text-3xl font-bold tracking-tight">Jan 2025</dd>
            <dd className="mt-1 text-sm text-muted-foreground">
              Deep Dive beer goes on sale
            </dd>
          </div>
        </dl>
      </Reveal>

      {/* 2 · Brewing on a small Caribbean island */}
      <Reveal as="section" className="mt-20 md:mt-28">
        <SectionIntro eyebrow="The Island" title="Brewing on a small Caribbean island" />
        {/* TODO(owner): water story: source (rain catchment? desalinated?)
            and treatment are not documented in the repo; add only verified
            detail. Same for freight: name the consolidator/route or sailing
            line only if you want it public. */}
        <EditorialSplit
          src="/photos/herograin.jpg"
          alt="Freshly milled brewing grain spiraling in the mill"
          caption="Milled grain: the start of every batch, and one more thing that crossed an ocean to get here."
          className="mt-10"
        >
          <div className="space-y-4 text-muted-foreground">
            <p>
              Nearly everything we brew with crosses an ocean first.
              Ingredients have to reach the right place in Florida, make the
              correct sailing, arrive on Saba, clear the logistics at Fort
              Bay, and finally make their way to us on a shared container
              that lands every two weeks.
            </p>
            <p>
              Gas is prohibitively expensive here, so the brewery runs
              entirely on electricity. And on a five-square-mile island,
              water, energy, and waste are not abstractions; they are things
              you notice every day.
            </p>
            <p>
              Saba&rsquo;s diving culture has always encouraged people to
              think about the environment around them. That mindset carries
              naturally into the brewery: we plan carefully, use our space
              efficiently, and think hard about what we bring to the island
              and what we do with it afterward.
            </p>
          </div>
        </EditorialSplit>
      </Reveal>

      {/* 3 · Inside the brewery */}
      <Reveal as="section" className="mt-20 md:mt-28">
        <SectionIntro eyebrow="The Brewhouse" title="Inside the brewery" />
        {/* TODO(owner): brewhouse capacity (bbl/L), vessel count, and canning
            approach are not documented; add verified specs here if you want
            them public. */}
        <EditorialSplit
          src="/photos/PXL_20261006_121633967.jpg"
          alt="The Alpha Brewing Operations mash tun, its manway sight glass showing the mash inside"
          caption="The Alpha mash tun, part of the brewhouse installed at Fort Bay in 2024."
          reverse
          portrait
          className="mt-10"
        >
          <div className="space-y-4 text-muted-foreground">
            <p>
              After developing recipes on a small homebrew pilot system, we
              ordered a professional brewing system from Alpha Brewing
              Operations in Nebraska. It arrived on Saba in October 2024. We
              brewed our first batch that December; the first Deep Dive beer
              went on sale in January 2025.
            </p>
            <p>
              Brewing on a small island leaves little room for shortcuts. We
              carefully manage our water, minerals, fermentation, and cold
              filtration to produce consistent beer with the quality and
              shelf stability our environment demands.
            </p>
          </div>
        </EditorialSplit>
      </Reveal>

      <Reveal className="mt-16 md:mt-24">
        <EditorialFigure
          src="/photos/PXL_20261006_121718700.jpg"
          alt="Hard-plumbed valve manifold with labeled green handles for kettle rinse, knockout, and clean-in-place"
          caption="Every transfer has a labeled valve: kettle rinse, knockout, clean-in-place."
        />
      </Reveal>

      {/* 4 · From grain to glass */}
      <Reveal as="section" className="mt-20 md:mt-28">
        <SectionIntro eyebrow="The Process" title="From grain to glass">
          <p>
            The steps are the same ones breweries everywhere follow. The
            difference is the room they happen in, and the ocean every
            ingredient crossed first.
          </p>
        </SectionIntro>
        {/* TODO(owner): review step copy: add batch size, fermentation
            times, or canning-day detail only if you want them public. */}
        <div className="mt-10">
          <ProcessSteps>
            <ProcessStep step="01" title="Mash">
              Milled grain meets hot water in the mash tun, where enzymes
              convert starch into the sugars that give the beer its body and
              strength.
            </ProcessStep>
            <ProcessStep step="02" title="Boil">
              The sweet wort is boiled with hops for bitterness, balance, and
              aroma, using electric heat like everything else in the brewhouse.
            </ProcessStep>
            <ProcessStep step="03" title="Fermentation">
              Yeast turns wort into beer inside our stainless fermenters.
            </ProcessStep>
            <ProcessStep step="04" title="Conditioning">
              The beer rests and is cold-filtered to help maintain consistency
              and shelf stability in our climate.
            </ProcessStep>
            <ProcessStep step="05" title="Packaging">
              Beer leaves the brewery in kegs and cans: draft for bars and
              restaurants, cans for shelves and coolers.
            </ProcessStep>
          </ProcessSteps>
        </div>
      </Reveal>

      <Reveal className="mt-16 md:mt-24">
        <EditorialFigure
          src="/photos/PXL_20261006_121738963.jpg"
          alt="A row of stainless fermenters with hoses overhead in the Fort Bay brewery"
          caption="The fermenter row, where each batch spends most of its time before packaging."
        />
      </Reveal>

      {/* 5 · Made for Saba */}
      <Reveal as="section" className="mt-20 md:mt-28">
        <SectionIntro eyebrow="The Beer" title="Made for Saba, poured nearby" />
        <EditorialSplit
          src="/photos/video-still.jpg"
          alt="Beer flowing through an inline sight glass on the brewhouse"
          caption="Beer on the move through a brewhouse sight glass."
          className="mt-10"
        >
          <div className="space-y-4 text-muted-foreground">
            <p>
              You can find Deep Dive at most bars and restaurants on Saba,
              and our cans in local shops. We have started sending beer to
              the Dutch side of Sint Maarten, including accounts in
              Philipsburg, and expansion to Sint Eustatius is in progress.
            </p>
            <p>
              We also try to keep useful byproducts on the island. Spent
              grain finds new life as animal feed, compost, and dog treats,
              and our filtered water goes to the Marine Laboratory, reducing
              the distilled water they need to bring in for experiments.
            </p>
            <p>
              There is no taproom, but the brewery itself is open for tours
              by request. The people pouring, stocking, and drinking our beer
              are not abstract markets to us. They are neighbors we know.
            </p>
          </div>
        </EditorialSplit>
      </Reveal>

      {/* 6 · Calls to action: reuse the existing tour inquiry dialog and
          conversion-event wiring rather than a new booking flow. */}
      <Reveal as="section" className="mt-20 border-t border-stone pt-16 md:mt-28">
        <div className="mx-auto max-w-180 text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Come taste the island
          </h2>
          <p className="mt-4 text-muted-foreground">
            See the lineup, find a pour nearby, or come stand in the
            678-square-foot room where it all happens.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <Button asChild className="h-11 min-h-[44px] px-6">
              <Link href="/beers">Explore Our Beers</Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="h-11 min-h-[44px] px-6"
            >
              <Link
                href="/where-to-buy"
                data-analytics-event="where_to_buy_click"
                data-analytics-event-category="conversion"
                data-analytics-event-label="Where to Buy"
                data-analytics-cta-location="brewed_on_saba"
              >
                Where to Buy
              </Link>
            </Button>
            <TourInquiryCta
              ctaLocation="brewed_on_saba"
              variant="outline"
              className="h-11 min-h-[44px] px-6"
            >
              Book a Brewery Tour
            </TourInquiryCta>
          </div>
        </div>
      </Reveal>
    </main>
  );
}
