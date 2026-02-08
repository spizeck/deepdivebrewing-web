import type { Metadata } from "next";

interface BeerDetailPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: BeerDetailPageProps): Promise<Metadata> {
  const { slug } = await params;
  // TODO: Fetch beer by slug from Firestore for dynamic metadata
  return {
    title: `${slug} | Deep Dive Brewing Co`,
  };
}

export default async function BeerDetailPage({ params }: BeerDetailPageProps) {
  const { slug } = await params;
  // TODO: Fetch beer by slug from Firestore and render detail view
  return (
    <main className="mx-auto max-w-300 px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">{slug}</h1>
      <p className="mt-2 text-muted-foreground">
        Beer detail page — coming soon.
      </p>
    </main>
  );
}
