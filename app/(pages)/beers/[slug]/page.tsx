import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { notFound } from "next/navigation";
import { BeerViewTracker } from "@/components/beer-view-tracker";
import { getBeerBySlug, beerImageUrl } from "@/lib/beers";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://deepdivebrewing.com";

interface BeerDetailPageProps {
  params: Promise<{ slug: string }>;
}

function buildBeerMetaDescription(beer: {
  name: string;
  style: string;
  abv: number;
  tastingNotes: string[];
}): string {
  const article = /^[aeiou]/i.test(beer.style) ? "an" : "a";
  const abvText = beer.abv > 0 ? `${beer.abv}% ABV` : "0% ABV";
  const differentiator = beer.tastingNotes[0]
    ? `${beer.tastingNotes[0].toLowerCase()} character`
    : "island-crafted";
  return `${beer.name} — ${article} ${beer.style} at ${abvText}, brewed on Saba. ${differentiator} from Deep Dive Brewing Co.`;
}

export async function generateMetadata({
  params,
}: BeerDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const beer = await getBeerBySlug(slug);
  if (!beer) {
    return {
      title: "Beer Not Found",
      robots: { index: false },
    };
  }

  const imageUrl = beerImageUrl(beer.images.heroPath);
  const description = buildBeerMetaDescription(beer);

  return {
    title: beer.name,
    description,
    alternates: {
      canonical: `/beers/${beer.slug}`,
    },
    openGraph: {
      title: `${beer.name} | Deep Dive Brewing Co`,
      description,
      type: "article",
      url: `/beers/${beer.slug}`,
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: beer.name,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `${beer.name} | Deep Dive Brewing Co`,
      description,
      images: [imageUrl],
    },
  };
}

export default async function BeerDetailPage({ params }: BeerDetailPageProps) {
  const { slug } = await params;
  const beer = await getBeerBySlug(slug);
  if (!beer) notFound();

  const imageUrl = beerImageUrl(beer.images.heroPath);
  const description = buildBeerMetaDescription(beer);

  const additionalProperties: Array<Record<string, unknown>> = [
    {
      "@type": "PropertyValue",
      name: "Alcohol by Volume",
      value: beer.abv > 0 ? `${beer.abv}%` : "0%",
      unitText: "percent",
    },
  ];

  if (beer.ibu != null) {
    additionalProperties.push({
      "@type": "PropertyValue",
      name: "International Bitterness Units",
      value: String(beer.ibu),
      unitText: "IBU",
    });
  }

  if (beer.srm != null) {
    additionalProperties.push({
      "@type": "PropertyValue",
      name: "Standard Reference Method",
      value: String(beer.srm),
      unitText: "SRM",
    });
  }

  const beerJsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: beer.name,
    description,
    image: imageUrl,
    brand: {
      "@type": "Brewery",
      name: "Deep Dive Brewing Co",
      url: siteUrl,
    },
    manufacturer: {
      "@type": "Brewery",
      name: "Deep Dive Brewing Co",
      url: siteUrl,
    },
    additionalProperty: additionalProperties,
  };

  return (
    <main id="main-content" className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
      <BeerViewTracker
        slug={beer.slug}
        name={beer.name}
        style={beer.style}
        status={beer.status}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(beerJsonLd) }}
      />
      {/* Breadcrumb */}
      <nav className="mb-8 text-sm text-muted-foreground">
        <Link
          href="/beers"
          className="transition-opacity duration-200 hover:opacity-85"
        >
          Our Beers
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink">
          {beer.name}
        </span>
      </nav>

      <div className="flex flex-col gap-8 lg:flex-row lg:gap-12">
        {/* Beer image */}
        <div className="w-full lg:w-2/5">
          <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-stone/50">
            <Image
              src={beerImageUrl(beer.images.heroPath)}
              alt={beer.name}
              fill
              quality={80}
              className="object-cover"
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 40vw"
            />
          </div>
        </div>

        {/* Beer details */}
        <div className="w-full lg:w-3/5">
          <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
            {beer.name}
          </h1>

          <p className="mt-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {beer.style}
          </p>

          {/* Specs */}
          <div className="mt-6 flex flex-wrap gap-3">
            <Badge variant="secondary">{beer.abv}% ABV</Badge>
            <Badge variant="outline">{beer.status}</Badge>
            {beer.ibu && <Badge variant="outline">{beer.ibu} IBU</Badge>}
            {beer.srm && <Badge variant="outline">SRM {beer.srm}</Badge>}
          </div>

          {/* Description */}
          <p className="mt-6 text-muted-foreground">
            {beer.descriptionShort}
          </p>

          {/* Tasting notes */}
          {beer.tastingNotes.length > 0 && (
            <div className="mt-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-ink">
                Tasting Notes
              </h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {beer.tastingNotes.map((note) => (
                  <Badge key={note} variant="secondary">
                    {note}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Where to find */}
          <div className="mt-8 border-t border-stone pt-6">
            <p className="text-sm text-muted-foreground">
              Want to try this beer?
            </p>
            <Link
              href="/where-to-buy"
              data-analytics-event="where_to_buy_click"
              data-analytics-event-category="conversion"
              data-analytics-event-label="See where to buy"
              data-analytics-beer-slug={beer.slug}
              data-analytics-beer-name={beer.name}
              data-analytics-beer-style={beer.style}
              data-analytics-cta-location="beer_detail_page"
              className="mt-1 inline-flex min-h-[44px] items-center text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85"
            >
              See where to buy &rarr;
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
