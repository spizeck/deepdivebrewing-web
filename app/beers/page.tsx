import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Our Beers | Deep Dive Brewing Co",
  description: "Explore the full range of beers from Deep Dive Brewing Co.",
};

export default function BeersPage() {
  // TODO: Fetch beers from Firestore and render catalog
  return (
    <main className="mx-auto max-w-300 px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight">Our Beers</h1>
      <p className="mt-2 text-muted-foreground">
        Coming soon — our full beer catalog.
      </p>
    </main>
  );
}
