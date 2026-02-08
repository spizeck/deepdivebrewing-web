import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
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

  // TODO: Uncomment when Firestore is connected
  // const beer = await getBeerBySlug(slug);
  // if (!beer) notFound();

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

      <div className="grid gap-12 lg:grid-cols-2">
        {/* Beer image */}
        <div className="aspect-3/4 w-full overflow-hidden rounded-lg bg-stone/50">
          {/* TODO: Replace with <Image src={beer.images.hero} /> */}
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">Beer image</p>
          </div>
        </div>

        {/* Beer details */}
        <div>
          {/* TODO: Use beer.name with Money Money Plus font */}
          <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
            {slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
          </h1>

          {/* TODO: Use beer.style with AccaciaFlare Bold font */}
          <p className="mt-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Beer Style
          </p>

          {/* Specs */}
          <div className="mt-6 flex flex-wrap gap-3">
            <Badge variant="secondary">0.0% ABV</Badge>
            <Badge variant="outline">Core</Badge>
            {/* TODO: Conditionally show IBU, SRM */}
          </div>

          {/* Description */}
          <p className="mt-8 text-muted-foreground">
            {/* TODO: beer.descriptionShort */}
            Beer description will appear here once connected to Firestore.
          </p>

          {/* Tasting notes */}
          <div className="mt-8">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-ink">
              Tasting Notes
            </h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {/* TODO: Map beer.tastingNotes */}
              {["Note 1", "Note 2", "Note 3"].map((note) => (
                <Badge key={note} variant="secondary">
                  {note}
                </Badge>
              ))}
            </div>
          </div>

          {/* Where to find */}
          <div className="mt-12 border-t border-stone pt-8">
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
