import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { Badge } from "@/components/ui/badge";
import type { Beer } from "@/lib/types";
// import { notFound } from "next/navigation";
// import { getBeerBySlug } from "@/lib/beers";

interface BeerDetailPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: BeerDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  // TODO: Fetch beer by slug from Firestore for dynamic metadata
  // const beer = await getBeerBySlug(slug);
  // if (!beer) return {};
  return {
    title: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    // description: beer.descriptionShort,
  };
}

export default async function BeerDetailPage({ params }: BeerDetailPageProps) {
  const { slug } = await params;

  // TODO: Replace with Firestore fetch once seeded
  // const beer = await getBeerBySlug(slug);
  // if (!beer) notFound();
  const beer = null as Beer | null;

  return (
    <main className="mx-auto max-w-300 px-6 py-20 md:py-30">
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
          {slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
        </span>
      </nav>

      <div className="flex flex-col gap-8 lg:flex-row lg:gap-12">
        {/* Beer image */}
        <div className="w-full lg:w-2/5">
          <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-stone/50">
            {beer ? (
              <Image
                src={beer.images.hero}
                alt={beer.name}
                fill
                className="object-cover"
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 40vw"
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-muted-foreground">Beer image</p>
              </div>
            )}
          </div>
        </div>

        {/* Beer details */}
        <div className="w-full lg:w-3/5">
          <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
            {beer ? beer.name : slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
          </h1>

          <p className="mt-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {beer ? beer.style : "Beer Style"}
          </p>

          {/* Specs */}
          <div className="mt-6 flex flex-wrap gap-3">
            <Badge variant="secondary">{beer ? `${beer.abv}% ABV` : "0.0% ABV"}</Badge>
            <Badge variant="outline">{beer ? beer.status : "Core"}</Badge>
            {beer && beer.ibu && <Badge variant="outline">{beer.ibu} IBU</Badge>}
            {beer && beer.srm && <Badge variant="outline">SRM {beer.srm}</Badge>}
          </div>

          {/* Description */}
          <p className="mt-6 text-muted-foreground">
            {beer ? beer.descriptionShort : "Beer description will appear here once connected to Firestore."}
          </p>

          {/* Tasting notes */}
          <div className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-ink">
              Tasting Notes
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {/* TODO: Map beer.tastingNotes */}
              {(beer ? beer.tastingNotes : ["Note 1", "Note 2", "Note 3"]).map((note) => (
                <Badge key={note} variant="secondary">
                  {note}
                </Badge>
              ))}
            </div>
          </div>

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
