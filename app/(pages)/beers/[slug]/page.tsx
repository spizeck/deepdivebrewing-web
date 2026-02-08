import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import { notFound } from "next/navigation";
import { getBeerBySlug, beerImageUrl } from "@/lib/beers";

interface BeerDetailPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: BeerDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  const beer = await getBeerBySlug(slug);
  if (!beer) return { title: "Beer Not Found" };
  return {
    title: beer.name,
    description: beer.descriptionShort,
  };
}

export default async function BeerDetailPage({ params }: BeerDetailPageProps) {
  const { slug } = await params;
  const beer = await getBeerBySlug(slug);
  if (!beer) notFound();

  return (
    <main className="mx-auto max-w-300 px-6 pb-20 md:pb-30">
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
              className="mt-1 inline-block text-sm font-medium text-ocean transition-opacity duration-200 hover:opacity-85"
            >
              See where to buy &rarr;
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
